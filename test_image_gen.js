const fetch = require("node-fetch");
const fs = require("fs");
require("dotenv").config({ path: "/root/ianews/.env" });

async function test() {
  // Test OpenRouter free image models
  const freeModels = [
    "stabilityai/stable-diffusion-3.5-large:free",
    "black-forest-labs/flux-schnell:free",
  ];

  for (const model of freeModels) {
    console.log(`\n=== OpenRouter: ${model} ===`);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://ianews.app",
          "X-Title": "iAnews Video Generator",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "A futuristic AI neural network visualization, glowing blue nodes, cinematic lighting, digital art" }],
          max_tokens: 1024,
        }),
        timeout: 60000,
      });
      console.log(`  Status: ${res.status}`);
      const rawText = await res.text();
      console.log(`  Response (${rawText.length} chars): ${rawText.substring(0, 300)}`);
      
      if (res.ok && rawText.length > 100) {
        try {
          const data = JSON.parse(rawText.trim());
          const choice = data.choices?.[0];
          const images = choice?.message?.images;
          const content = choice?.message?.content || "";
          
          if (images && images.length > 0) {
            let base64 = images[0]?.image_url?.url || images[0];
            if (typeof base64 === "string") {
              if (base64.startsWith("data:")) base64 = base64.split(",")[1];
              const buf = Buffer.from(base64, "base64");
              if (buf.length > 1000) {
                const fname = `/tmp/test_or_${model.split("/")[1].split(":")[0]}.jpg`;
                fs.writeFileSync(fname, buf);
                console.log(`  Image saved: ${Math.round(buf.length/1024)} KB -> ${fname}`);
              }
            }
          } else if (content.includes("http")) {
            const urlMatch = content.match(/https?:\/\/[^\s\]\)]+\.(?:png|jpg|jpeg|webp)[^\s\]\)]*/i);
            if (urlMatch) {
              const imgRes = await fetch(urlMatch[0], { timeout: 30000, redirect: "follow" });
              const buf = Buffer.from(await imgRes.arrayBuffer());
              if (buf.length > 1000) {
                const fname = `/tmp/test_or_${model.split("/")[1].split(":")[0]}.jpg`;
                fs.writeFileSync(fname, buf);
                console.log(`  Image from URL: ${Math.round(buf.length/1024)} KB -> ${fname}`);
              }
            }
          }
        } catch(e) { console.log(`  Parse: ${e.message}`); }
      }
    } catch(e) { console.log(`  Error: ${e.message?.substring(0,80)}`); }
  }
  
  // Test Pollinations with different models
  console.log("\n=== Pollinations model comparison ===");
  const models = ["flux-schnell", "flux", "turbo"];
  for (const m of models) {
    try {
      const url = `https://image.pollinations.ai/prompt/AI+neural+network+futuristic+cinematic?width=576&height=1024&nologo=true&seed=42&model=${m}`;
      const res = await fetch(url, { timeout: 30000, redirect: "follow" });
      const buf = Buffer.from(await res.arrayBuffer());
      const ok = buf.length > 5000 && buf[0]===0xFF && buf[1]===0xD8;
      console.log(`  ${m}: ${res.status}, ${Math.round(buf.length/1024)} KB, JPEG: ${ok}`);
      if (ok) fs.writeFileSync(`/tmp/test_pollinations_${m}.jpg`, buf);
    } catch(e) { console.log(`  ${m}: ${e.message?.substring(0,60)}`); }
  }
}

test().catch(e => console.error(e.message));
