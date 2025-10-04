#!/usr/bin/env node

import { readdir, readFile, stat } from "fs/promises";
import { extname, join } from "path";

interface ComponentInfo {
  file: string;
  components: string[];
}

interface CountResult {
  totalComponents: number;
  componentsByFile: ComponentInfo[];
  filesScanned: number;
  timeTaken: number;
}

// Optimized regex patterns for detecting React components
const COMPONENT_PATTERNS = [
  // Function components: function ComponentName() { return ... }
  /function\s+([A-Z][a-zA-Z0-9]*)\s*\([^)]*\)\s*(?::\s*(?:React\.)?(?:ReactElement|ReactNode|JSX\.Element|FC|FunctionComponent)[^{]*)?{/g,

  // Arrow function components: const ComponentName = () => ...
  /(?:const|let|var)\s+([A-Z][a-zA-Z0-9]*)\s*(?::\s*(?:React\.)?(?:FC|FunctionComponent)[^=]*)?\s*=\s*(?:React\.memo\s*\()?\s*(?:React\.forwardRef\s*\()?\s*\([^)]*\)\s*(?::\s*(?:React\.)?(?:ReactElement|ReactNode|JSX\.Element)[^=]*)?\s*=>/g,

  // Class components: class ComponentName extends React.Component
  /class\s+([A-Z][a-zA-Z0-9]*)\s+extends\s+(?:React\.)?(?:Component|PureComponent)/g,

  // Export default function components
  /export\s+default\s+function\s+([A-Z][a-zA-Z0-9]*)/g,

  // Named export components: export const ComponentName = ...
  /export\s+(?:const|let|var)\s+([A-Z][a-zA-Z0-9]*)\s*(?::\s*(?:React\.)?(?:FC|FunctionComponent)[^=]*)?\s*=\s*(?:React\.memo\s*\()?\s*(?:React\.forwardRef\s*\()?\s*\([^)]*\)\s*(?::\s*[^=]*)?\s*=>/g,

  // Export function: export function ComponentName
  /export\s+function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g,
];

// File extensions to scan
const VALID_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js"]);

// Directories to ignore
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  "coverage",
  ".cache",
  "out",
  ".turbo",
  ".vercel",
]);

/**
 * Extracts component names from file content using optimized regex patterns
 * Space complexity: O(n) where n is the number of unique components found
 * Time complexity: O(m) where m is the content length
 */
function extractComponents(content: string): string[] {
  const components = new Set<string>();

  // Check if file likely contains React code (optimization to skip non-React files)
  if (
    !content.includes("React") &&
    !content.includes("jsx") &&
    !content.includes("tsx") &&
    !content.includes("return (") &&
    !content.includes("return(")
  ) {
    // Quick heuristic: if no React indicators, only check for JSX return patterns
    if (!/return\s*</.test(content)) {
      return [];
    }
  }

  for (const pattern of COMPONENT_PATTERNS) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        // Verify it's likely a component (returns JSX or has React-specific patterns)
        const componentName = match[1];

        // Filter out common non-component patterns
        if (
          componentName.length > 1 &&
          !["Test", "Mock", "Util", "Helper", "Config"].includes(componentName)
        ) {
          components.add(componentName);
        }
      }
    }
  }

  return Array.from(components);
}

/**
 * Recursively scans directory for React component files
 * Uses async iteration to avoid loading entire directory tree into memory
 * Space complexity: O(d) where d is the maximum depth of directory tree
 * Time complexity: O(n) where n is the total number of files/directories
 */
async function* scanDirectory(dirPath: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    // Skip directories we don't have permission to read
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Skip ignored directories
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      // Recursively scan subdirectories
      yield* scanDirectory(fullPath);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (VALID_EXTENSIONS.has(ext)) {
        yield fullPath;
      }
    }
  }
}

/**
 * Processes files with controlled concurrency to optimize performance
 * Uses Promise.all with batching to prevent memory overflow
 * Space complexity: O(b) where b is the batch size
 * Time complexity: O(n/p) where n is files count and p is parallelism level
 */
async function processFiles(
  files: AsyncGenerator<string>,
  batchSize: number = 50
): Promise<ComponentInfo[]> {
  const results: ComponentInfo[] = [];
  let batch: Promise<ComponentInfo | null>[] = [];

  for await (const filePath of files) {
    batch.push(processFile(filePath));

    if (batch.length >= batchSize) {
      const batchResults = await Promise.all(batch);
      results.push(
        ...batchResults.filter((r): r is ComponentInfo => r !== null)
      );
      batch = [];
    }
  }

  // Process remaining files
  if (batch.length > 0) {
    const batchResults = await Promise.all(batch);
    results.push(...batchResults.filter((r): r is ComponentInfo => r !== null));
  }

  return results;
}

/**
 * Processes a single file to extract React components
 * Space complexity: O(s) where s is the file size
 * Time complexity: O(s) where s is the file size
 */
async function processFile(filePath: string): Promise<ComponentInfo | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const components = extractComponents(content);

    if (components.length > 0) {
      return {
        file: filePath,
        components,
      };
    }
  } catch (error) {
    // Skip files we can't read
  }

  return null;
}

/**
 * Main function to count React components in a project
 * Overall space complexity: O(n) where n is total number of components
 * Overall time complexity: O(f*s) where f is file count and s is avg file size
 */
async function countReactComponents(projectPath: string): Promise<CountResult> {
  const startTime = Date.now();

  // Verify directory exists
  try {
    const stats = await stat(projectPath);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${projectPath}`);
    }
  } catch (error) {
    throw new Error(`Invalid directory: ${projectPath}`);
  }

  console.log(`🔍 Scanning ${projectPath} for React components...\n`);

  // Stream files and process them in batches
  const files = scanDirectory(projectPath);
  const componentsByFile = await processFiles(files);

  // Calculate totals
  const totalComponents = componentsByFile.reduce(
    (sum, info) => sum + info.components.length,
    0
  );

  const timeTaken = Date.now() - startTime;

  return {
    totalComponents,
    componentsByFile,
    filesScanned: componentsByFile.length,
    timeTaken,
  };
}

/**
 * Formats and displays the results
 */
function displayResults(result: CountResult, verbose: boolean = false): void {
  console.log(`✅ Scan completed in ${result.timeTaken}ms\n`);
  console.log(`📊 Results:`);
  console.log(`   Total Components: ${result.totalComponents}`);
  console.log(`   Files with Components: ${result.filesScanned}`);

  if (verbose && result.componentsByFile.length > 0) {
    console.log(`\n📁 Components by file:\n`);

    // Sort by number of components (descending)
    const sorted = [...result.componentsByFile].sort(
      (a, b) => b.components.length - a.components.length
    );

    for (const info of sorted) {
      console.log(`   ${info.file}`);
      console.log(`   └─ ${info.components.join(", ")}`);
      console.log();
    }
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);

  let projectPath = process.cwd();
  let verbose = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      console.log(`
React Component Counter - Optimized for speed and memory efficiency

Usage:
  count-components [options] [path]

Options:
  -h, --help      Show this help message
  -v, --verbose   Show detailed output with all components by file
  [path]          Path to the React project (defaults to current directory)

Examples:
  count-components
  count-components ./my-react-app
  count-components -v /path/to/project
  count-components --verbose ./src
      `);
      process.exit(0);
    } else if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (!arg.startsWith("-")) {
      projectPath = arg;
    }
  }

  try {
    const result = await countReactComponents(projectPath);
    displayResults(result, verbose);
  } catch (error) {
    console.error(
      `❌ Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { countReactComponents, type ComponentInfo, type CountResult };
