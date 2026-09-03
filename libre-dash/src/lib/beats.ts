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
 * Where the mp3s live depends on how we are running: `astro dev` and
 * `astro preview` serve them straight out of public/, but a built server has
 * had public/ folded into the client output and public/ itself is not shipped.
 */
const BEAT_DIRS = [
  path.join(process.cwd(), "dist", "client", "beats"),
  path.join(process.cwd(), "client", "beats"),
  path.join(process.cwd(), "public", "beats"),
];

function findBeatsDir(): string | null {
  for (const dir of BEAT_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Reads the beats directory and pulls title + tempo out of the filenames,
 * which look like "GLORIFIED _ @su00ki 140.mp3": everything before the @ is
 * the title, the trailing number is the tempo.
 */
export function getBeats(): Beat[] {
  if (cache) return cache;

  const beatsDir = findBeatsDir();
  if (!beatsDir) {
    console.error(`No beats directory found; looked in: ${BEAT_DIRS.join(", ")}`);
    return [];
  }

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
    console.error(`Error reading beats directory ${beatsDir}:`, error);
    return [];
  }
}
