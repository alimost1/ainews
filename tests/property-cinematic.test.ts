import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { planGallery, frameTimeline } from '../src/pipeline/property-cinematic';
import { motionRequest, validateMotion, generateHiggsfield } from '../src/pipeline/property-models';
import { hfAvatarSegment, segmentNarration } from '../src/pipeline/property-presentation';
import { extractListingFromHtml } from '../src/pipeline/property-extract';

test('gallery edits every four seconds independently of narration, with real overlap', () => {
  const shots = planGallery([{photo:'a'}, {photo:'b'}, {photo:'c'}], 600, 30);
  assert.equal(shots.length, 5);
  assert.deepEqual(shots.map(s => s.photo), ['a','b','c','a','b']);
  assert.equal(shots[0].from, 0);
  assert.equal(shots[0].duration, 132);
  for (let i = 1; i < shots.length; i++) assert.ok(shots[i].from < shots[i-1].from + shots[i-1].duration);
  assert.equal(shots.at(-1)!.from + shots.at(-1)!.duration, 600);
  assert.throws(() => planGallery([], 30), /photo/);
});

test('all selected gallery photos participate even with fewer narration segments', () => {
  const assets = Array.from({length:9}, (_,i)=>({photo:String(i)}));
  assert.equal(new Set(planGallery(assets, 600).map(s=>s.photo)).size, 9);
});

test('frame timeline has no gaps or overlapping narration at fractional durations', () => {
  assert.deepEqual(frameTimeline([4.015,3.1],30), [{from:0,duration:121},{from:121,duration:93}]);
  assert.throws(()=>frameTimeline([0],30),/duration/);
  const text = Array(37).fill('mot').join(' ');
  assert.ok(segmentNarration(text).every(s=>s.split(' ').length<=36));
});

test('motion requests use documented per-model schemas and source photo', () => {
  const kling = motionRequest('kling-3-pro','https://example.com/real.jpg',0);
  assert.equal(kling.image_url,'https://example.com/real.jpg');
  assert.equal(kling.duration,5);
  assert.equal((kling as any).sound,'off');
  assert.equal((kling as any).resolution,undefined); // not in the Kling schema
  assert.equal((kling as any).audio_url,undefined);
  const wan = motionRequest('wan-3','https://example.com/real.jpg',1);
  assert.equal((wan as any).resolution,'1080p');
  assert.equal((wan as any).generate_audio,false);
  assert.notEqual(wan.prompt,kling.prompt);
  assert.match(wan.prompt,/Preserve the building geometry/);
  assert.equal(validateMotion(undefined),'photo');
  assert.throws(()=>validateMotion('invented-model'));
});

test('persist provider handle before polling; resumed requests never POST again', async () => {
  const original = global.fetch;
  let posts=0, persisted=false;
  let resume: any;
  try {
    global.fetch = async (_url, init) => {
      if (init?.method==='POST') {
        posts++;
        return Response.json({request_id:'real-provider-id',status_url:'https://api.higgsfield.ai/requests/real-provider-id/status'});
      }
      assert.ok(persisted);
      return Response.json({status:'completed',video:{url:'https://cdn.example.com/video.mp4'}});
    };
    const opts = {endpoint:'model', input:{},keyId:'test',keySecret:'test', wait:async()=>{},
      onSubmitted:(handle:any)=>{persisted=true;resume=handle;}};
    const first = await generateHiggsfield(opts);
    assert.equal(first.requestId,'real-provider-id');
    await generateHiggsfield({...opts,resume});
    assert.equal(posts,1);
  } finally { global.fetch=original; }
});

test('provider status URLs cannot receive credentials on a foreign origin', async () => {
  const original=global.fetch;
  let calls=0;
  try {
    global.fetch=async()=>{calls++;return Response.json({request_id:'id',status_url:'https://attacker.example/status'});};
    await assert.rejects(generateHiggsfield({endpoint:'model',input:{},keyId:'x',keySecret:'y',onSubmitted:()=>{}}),/status URL/);
    assert.equal(calls,1);
  } finally {global.fetch=original;}
});

test('avatar rejects narration longer than provider limit before submitting', async () => {
  await assert.rejects(hfAvatarSegment({keyId:'x',keySecret:'y',imageUrl:'x',audioUrl:'x',prompt:'x',durationSec:15.1,aspectRatio:'9:16'}),/15s/);
});

test('property page JavaScript parses and offers real model choices', () => {
  const html=fs.readFileSync('public/property.html','utf8');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]);
  assert.match(html,/value="kling-3-pro"/);
  assert.match(html,/value="wan-3"/);
});

test('Promo Immo extractor excludes similar listings from facts and gallery', () => {
  const html='<h1>Villa</h1><p>8560000 dhs</p><img src="/assets/img/produit/VVM-344.jpg"><h2 class="titre_h2">Produits similaires :</h2><p>99999999 dhs</p><img src="/assets/img/produit/unrelated.jpg">';
  const listing=extractListingFromHtml(html,'https://www.promoimmomarrakech.com/produit/vvm-344/a.html');
  assert.equal(listing.images.length,1);
  assert.equal(listing.price,8560000);
});

test('voice preparation generates every segment and reuses completed audio on retry', async () => {
  const {prepareNarrationAudio}=await import('../src/pipeline/property-audio');
  const os=await import('node:os');
  const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'property-audio-'));
  const segments=[{text:'one'}, {text:'two'}, {text:'three'}];
  const generated:string[]=[];
  let saves=0;
  const opts={segments,audioDir:dir,generate:async(text:string,file:string)=>{generated.push(text);fs.writeFileSync(file,Buffer.alloc(300));},probe:()=>4.125,save:()=>{saves++;}};
  try {
    await prepareNarrationAudio(opts);
    assert.deepEqual(generated,['one','two','three']);
    assert.equal(saves,3);
    await prepareNarrationAudio(opts);
    assert.equal(generated.length,3);
    assert.ok(segments.every((s:any)=>s.audioSec===4.125));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
