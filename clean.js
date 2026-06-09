import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Folders to remove recursively
const foldersToClean = [
  path.join(__dirname, "dist"),
  path.join(__dirname, ".vite"),
  path.join(__dirname, "node_modules"),
];

console.log("Starting cleanup...");

foldersToClean.forEach((folder) => {
  if (fs.existsSync(folder)) {
    try {
      console.log(`Removing folder: ${folder}`);
      fs.rmSync(folder, { recursive: true, force: true });
    } catch (err) {
      console.error(`Failed to remove folder ${folder}:`, err.message);
    }
  }
});

// Remove test scratch files (test_*.ts) in the root directory
try {
  const files = fs.readdirSync(__dirname);
  files.forEach((file) => {
    // Make sure we don't delete files in the test/ subdirectory (since we only scan root)
    if (file.startsWith("test_") && file.endsWith(".ts")) {
      const filePath = path.join(__dirname, file);
      console.log(`Removing scratch file: ${filePath}`);
      fs.unlinkSync(filePath);
    }
  });
} catch (err) {
  console.error("Failed to clean scratch files:", err.message);
}

console.log("Cleanup complete!");
