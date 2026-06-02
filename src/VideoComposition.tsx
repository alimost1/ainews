import { FC } from "react";
import { Img, Audio, Sequence, useVideoConfig, staticFile } from "remotion";

interface Scene {
  scene_number: number;
  narration_text: string;
  duration_seconds: number;
  image_path: string;
  audio_path: string;
}

interface Props {
  scenes: Scene[];
}

export const VideoComposition: FC<Props> = ({ scenes }) => {
  const { fps } = useVideoConfig();
  let cumulativeFrames = 0;

  return (
    <>
      {scenes.map((scene) => {
        const startFrame = cumulativeFrames;
        const durationInFrames = scene.duration_seconds * fps;
        cumulativeFrames += durationInFrames;
        return (
          <Sequence key={scene.scene_number} from={startFrame} durationInFrames={durationInFrames}>
            <div style={{ width: 1280, height: 720, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#000" }}>
              <Img src={staticFile(scene.image_path)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
            <Audio src={staticFile(scene.audio_path)} />
          </Sequence>
        );
      })}
    </>
  );
};
