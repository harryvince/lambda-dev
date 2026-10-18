import { writeFile } from "node:fs/promises";
import { createConfigJsonSchema } from "../src/schema.js";

const outputPath = new URL("../docs/schema.json", import.meta.url);
await writeFile(outputPath, `${JSON.stringify(createConfigJsonSchema(), null, 2)}\n`);
console.log(`Wrote ${outputPath.pathname}`);
