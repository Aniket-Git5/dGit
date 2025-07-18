#!/usr/bin/env node

const { Actor, HttpAgent } = require("@dfinity/agent");
const { Ed25519KeyIdentity } = require("@dfinity/identity");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const ignore = require("ignore")();

const CANISTER_ID = "uxrrr-q7777-77774-qaaaq-cai";
const HOST = "http://127.0.0.1:8000";

const idlFactory = ({ IDL }) => {
  const Blob = IDL.Record({
    content: IDL.Text,
    contentType: IDL.Text,
  });
  const FilePath = IDL.Text;
  const Tree = IDL.Record({
    files: IDL.Vec(IDL.Tuple(FilePath, Blob)),
  });
  const CommitId = IDL.Text;
  const Commit = IDL.Record({
    id: CommitId,
    tree: Tree,
    parent: IDL.Opt(CommitId),
    message: IDL.Text,
    author: IDL.Principal,
    timestamp: IDL.Int,
  });
  const BranchName = IDL.Text;
  const Branch = IDL.Record({
    name: BranchName,
    head: CommitId,
  });
  const RepoId = IDL.Nat;
  const Repo = IDL.Record({
    id: RepoId,
    name: IDL.Text,
    owner: IDL.Principal,
    collaborators: IDL.Vec(IDL.Principal),
    isPublic: IDL.Bool,
  });
  const Result = IDL.Variant({ ok: IDL.Null, err: IDL.Text });
  const Result_1 = IDL.Variant({ ok: RepoId, err: IDL.Text });
  const Result_2 = IDL.Variant({ ok: CommitId, err: IDL.Text });
  const Result_4 = IDL.Variant({ ok: Commit, err: IDL.Text });

  return IDL.Service({
    createRepo: IDL.Func([IDL.Text, IDL.Bool], [Result_1], []),
    commitCode: IDL.Func(
      [RepoId, BranchName, IDL.Vec(IDL.Tuple(FilePath, Blob)), IDL.Text],
      [Result_2],
      []
    ),
    createBranch: IDL.Func([RepoId, BranchName, BranchName], [Result], []),
    mergeBranch: IDL.Func([RepoId, BranchName, BranchName], [Result], []),
    forkRepo: IDL.Func([RepoId, IDL.Text], [Result_1], []),
    addCollaborator: IDL.Func([RepoId, IDL.Principal], [Result], []),
    getRepo: IDL.Func([RepoId], [Repo], ["query"]),
    getCommit: IDL.Func([RepoId, CommitId], [Result_4], ["query"]),
    pushCommit: IDL.Func([RepoId, BranchName, CommitId], [Result], []),
  });
};

async function initActor() {
  const identity = Ed25519KeyIdentity.generate();
  const agent = new HttpAgent({ host: HOST, identity });
  await agent.fetchRootKey();
  return Actor.createActor(idlFactory, { agent, canisterId: CANISTER_ID });
}

// Initialize ignore with default patterns
ignore.add([
  "node_modules/",
  ".dgit",
  ".git/",
  ".DS_Store",
  ".dgit_staged_files",
]);

// Track staged files
const stagedFiles = new Set();
const STAGED_FILES_PATH = path.join(os.homedir(), ".dgit_staged_files");

async function loadStagedFiles() {
  try {
    const data = await fs.readFile(STAGED_FILES_PATH, "utf8");
    const files = JSON.parse(data);
    files.forEach((file) => stagedFiles.add(file));
  } catch (err) {
    // File doesn't exist yet
  }
}

async function saveStagedFiles() {
  await fs.writeFile(
    STAGED_FILES_PATH,
    JSON.stringify(Array.from(stagedFiles)),
    "utf8"
  );
}

async function loadIgnoreRules() {
  try {
    const ignoreContent = await fs.readFile(
      path.join(process.cwd(), ".dgitignore"),
      "utf8"
    );
    ignore.add(ignoreContent);
  } catch (err) {
    // .dgitignore doesn't exist, which is fine
  }
}

async function recursiveReadDir(dir, fileList = []) {
  const files = await fs.readdir(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory()) {
      await recursiveReadDir(fullPath, fileList);
    } else {
      const relativePath = path.relative(process.cwd(), fullPath);
      fileList.push(relativePath);
    }
  }
  return fileList;
}

async function readStagedFiles() {
  const files = [];
  for (const filePath of stagedFiles) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      files.push({
        path: filePath,
        content,
        contentType: path.extname(filePath),
      });
    } catch (err) {
      console.warn(`Warning: Could not read file ${filePath} - ${err.message}`);
    }
  }
  return files;
}

const commands = {
  init: async (repoName, isPublicArg = "true") => {
    if (!repoName) {
      console.error(
        "Error: Repository name is required. Usage: dgit init <name> [true|false]"
      );
      return;
    }
    const actor = await initActor();
    const isPublic = isPublicArg.toLowerCase() === "true";
    const result = await actor.createRepo(repoName, isPublic);
    if ("ok" in result) {
      console.log(`Repository created with ID: ${result.ok}`);
      await fs.writeFile(
        path.join(process.cwd(), ".dgit"),
        JSON.stringify({ repoId: result.ok.toString() }, null, 2)
      );
      try {
        await fs.access(path.join(process.cwd(), ".dgitignore"));
      } catch {
        await fs.writeFile(
          path.join(process.cwd(), ".dgitignore"),
          "# Add patterns to ignore\nnode_modules/\n.dgit\n"
        );
      }
    } else {
      console.error(`Error: ${result.err}`);
    }
  },

  add: async (...filePatterns) => {
    if (filePatterns.length === 0) {
      console.error(
        "Error: Please specify files to add. Usage: dgit add <file1> <file2> or dgit add ."
      );
      return;
    }
  
    await loadIgnoreRules();
    await loadStagedFiles(); // Load existing staged files first
    const allFiles = await recursiveReadDir(process.cwd());
    const filesToAdd = [];
    const alreadyStagedFiles = [];
    const newFiles = [];
  
    for (const pattern of filePatterns) {
      if (pattern === ".") {
        const filteredFiles = ignore.filter(allFiles);
        for (const file of filteredFiles) {
          if (stagedFiles.has(file)) {
            alreadyStagedFiles.push(file);
          } else {
            newFiles.push(file);
            filesToAdd.push(file);
          }
        }
      } else {
        const matchedFiles = allFiles.filter(
          (file) => file.includes(pattern) && !ignore.ignores(file)
        );
        if (matchedFiles.length === 0) {
          console.warn(`Warning: No files matched pattern '${pattern}'`);
        }
        for (const file of matchedFiles) {
          if (stagedFiles.has(file)) {
            alreadyStagedFiles.push(file);
          } else {
            newFiles.push(file);
            filesToAdd.push(file);
          }
        }
      }
    }
  
    filesToAdd.forEach((file) => stagedFiles.add(file));
    await saveStagedFiles();
  
    console.log(`Staging files...`);
    
    if (newFiles.length > 0) {
      console.log(`\nAdded ${newFiles.length} new file(s) to staging area:`);
      newFiles.forEach((file) => console.log(`+ ${file}`));
    }
    
    if (alreadyStagedFiles.length > 0) {
      console.log(`\n${alreadyStagedFiles.length} file(s) already staged:`);
      alreadyStagedFiles.forEach((file) => console.log(`= ${file}`));
    }
  
    if (newFiles.length === 0 && alreadyStagedFiles.length === 0) {
      console.log("No files were added (all matching files are either ignored or already staged)");
    }
  },

  // In the commands object:
  commit: async (message) => {
    if (!message) {
      console.error(
        'Error: Commit message is required. Usage: dgit commit "message"'
      );
      return;
    }

    await loadStagedFiles();
    if (stagedFiles.size === 0) {
      console.error(
        "Error: No files staged for commit. Use 'dgit add' to stage files first."
      );
      return;
    }

    const config = JSON.parse(
      await fs.readFile(path.join(process.cwd(), ".dgit"), "utf8")
    );
    const repoId = BigInt(config.repoId);
    const files = await readStagedFiles();

    const actor = await initActor();
    const result = await actor.commitCode(
      repoId,
      "main",
      files.map((f) => [
        f.path,
        { content: f.content, contentType: f.contentType },
      ]),
      message
    );

    if ("ok" in result) {
      console.log(`Commit created with ID: ${result.ok}`);
      // Store the latest commit ID in the config
      config.lastCommitId = result.ok;
      await fs.writeFile(
        path.join(process.cwd(), ".dgit"),
        JSON.stringify(config, null, 2)
      );
      stagedFiles.clear();
      await saveStagedFiles();
    } else {
      console.error(`Error: ${result.err}`);
    }
  },

  push: async () => {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), '.dgit'), 'utf8'));
    if (!config.lastCommitId) {
      console.error("❌ No commits found to push. Commit changes first with 'dgit commit'");
      return;
    }
  
    const repoId = BigInt(config.repoId);
    const actor = await initActor();
    
    // Get the commit data
    const commitResult = await actor.getCommit(repoId, config.lastCommitId);
    if ('err' in commitResult) {
      console.error(`❌ Failed to get commit: ${commitResult.err}`);
      return;
    }
    const commit = commitResult.ok;
  
    // Push using commitCode (re-creates the commit)
    const result = await actor.commitCode(
      repoId,
      'main',
      commit.tree.files,
      commit.message
    );
  
    if ('ok' in result) {
      console.log(`✅ Push successful! New Commit ID: ${result.ok}`);
    } else {
      console.error(`❌ Push failed: ${result.err}`);
    }
  },

  clone: async () => {
    const config = JSON.parse(
      await fs.readFile(path.join(process.cwd(), ".dgit"), "utf8")
    );
    const repoId = BigInt(config.repoId);
    const actor = await initActor();
    const repo = await actor.getRepo(repoId);
    if (!repo) {
      console.error("❌ Failed to fetch repository metadata.");
      return;
    }
    const branchName = "main";
    const branch = repo.branches?.find?.(([name]) => name === branchName);
    const latestCommitId = branch?.[1]?.head;
    if (!latestCommitId) {
      console.error("❌ No commit found in 'main' branch.");
      return;
    }
    const commitResult = await actor.getCommit(repoId, latestCommitId);
    if (!("ok" in commitResult)) {
      console.error(`❌ Failed to fetch commit: ${commitResult.err}`);
      return;
    }
    const commit = commitResult.ok;
    const files = commit.tree.files;
    for (const [filename, blob] of files) {
      const dir = path.dirname(filename);
      if (dir !== ".") {
        await fs.mkdir(dir, { recursive: true });
      }
      await fs.writeFile(filename, blob.content, "utf8");
      console.log(`✅ Cloned file: ${filename}`);
    }
    console.log(`✅ Clone complete. Latest commit: ${latestCommitId}`);
  },

  status: async () => {
    await loadStagedFiles();
    const config = JSON.parse(
      await fs.readFile(path.join(process.cwd(), ".dgit"), "utf8")
    );
    const repoId = BigInt(config.repoId);
    const actor = await initActor();
    const result = await actor.getRepo(repoId);

    console.log(`Repository: ${result.name}`);
    console.log(`Public: ${result.isPublic}`);
    console.log(
      `Owner: ${result.owner.toText ? result.owner.toText() : result.owner}`
    );
    console.log(
      `Collaborators: ${result.collaborators
        .map((p) => (p.toText ? p.toText() : p))
        .join(", ")}`
    );

    console.log("\nStaged files:");
    if (stagedFiles.size === 0) {
      console.log("  (no files staged)");
    } else {
      Array.from(stagedFiles).forEach((file) => console.log(`  ${file}`));
    }
  },
};

const args = process.argv.slice(2);
const command = args[0];
if (commands[command]) {
  commands[command](...args.slice(1)).catch(console.error);
} else {
  console.error(
    "Unknown command. Available commands: init, add, commit, status, push, clone"
  );
  console.log("\nUsage:");
  console.log("  dgit init <name> [true|false] - Create new repository");
  console.log("  dgit add <file1> <file2>     - Add files to staging area");
  console.log("  dgit add .                   - Add all non-ignored files");
  console.log('  dgit commit "message"        - Commit staged files');
  console.log("  dgit push                    - Push commits to repository");
  console.log("  dgit clone                   - Clone repository");
  console.log("  dgit status                  - Show repository status");
}
