import fs from "node:fs";
import path from "node:path";

export interface Beat {
  title: string;
  tempo: number;
  /** Raw filename, shown verbatim in the queue list. */
  file: string;
  mp3Url: string;
}

let cache: Beat[] | null = null;

/**
 * Reads public/beats and pulls title + tempo out of the filenames, which look
 * like "GLORIFIED _ @su00ki 140.mp3": everything before the @ is the title,
 * the trailing number is the tempo.
 */
export function getBeats(): Beat[] {
  if (cache) return cache;

  const beatsDir = path.join(process.cwd(), "public", "beats");

  try {
    cache = fs
      .readdirSync(beatsDir)
      .filter((file) => file.toLowerCase().endsWith(".mp3"))
      .map((file) => {
        const name = file.replace(/\.mp3$/i, "");
        const parts = name.split(" ");

        const parsed = parseInt(parts[parts.length - 1], 10);
        const tempo = Number.isNaN(parsed) ? 0 : parsed;

        let title = name;
        if (name.includes("@")) {
          title = name.split("@")[0].replace(/_/g, "").trim();
        }

        // encodeURI, not encodeURIComponent: the dev server matches the path
        // segment as the browser sends it, and over-encoding "@" 404s.
        const href = encodeURI(file).replace(/#/g, "%23").replace(/\?/g, "%3F");

        return { title, tempo, file, mp3Url: `/beats/${href}` };
      });
    return cache;
  } catch (error) {
    console.error("Error reading beats directory:", error);
    return [];
  }
}
