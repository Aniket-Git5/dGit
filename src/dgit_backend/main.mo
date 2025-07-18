import Principal "mo:base/Principal";
   import Text "mo:base/Text";
   import HashMap "mo:base/HashMap";
   import Array "mo:base/Array";
   import Iter "mo:base/Iter";
   import Time "mo:base/Time";
   import Buffer "mo:base/Buffer";
   import Nat "mo:base/Nat";
   import Result "mo:base/Result";
   import Hash "mo:base/Hash";
   import Int "mo:base/Int";
   import Option "mo:base/Option";

   actor RepoCanister {
       // Data structures
       type RepoId = Nat;
       type CommitId = Text;
       type BranchName = Text;
       type FilePath = Text;

       type Blob = {
           content: Text; // File content (e.g., .mo, .rs, .did source code)
           contentType: Text; // File extension (.mo, .rs, .did)
       };

       type Tree = {
           files: [(FilePath, Blob)]; // Maps file paths to blobs
       };

       type Commit = {
           id: CommitId; // Unique hash-like ID
           tree: Tree; // Files in this commit
           parent: ?CommitId; // Previous commit
           message: Text;
           author: Principal;
           timestamp: Int;
       };

       type Branch = {
           name: BranchName;
           head: CommitId; // Latest commit in the branch
       };

       type Repo = {
           id: RepoId;
           name: Text;
           owner: Principal;
           collaborators: [Principal]; // Users with write access
           isPublic: Bool; // Public or private repo
           branches: [(BranchName, Branch)]; // Store branches as array for stability
           commits: [(CommitId, Commit)]; // Store commits as array for stability
       };

       // Storage
       private stable var nextRepoId: Nat = 0;
       private stable var repos: [(RepoId, Repo)] = [];
       private var repoMap = HashMap.HashMap<RepoId, Repo>(10, Nat.equal, Hash.hash);

       // Initialize repos from stable storage
       system func preupgrade() {
           repos := Iter.toArray(repoMap.entries());
       };

       system func postupgrade() {
           repoMap := HashMap.fromIter<RepoId, Repo>(repos.vals(), 10, Nat.equal, Hash.hash);
           repos := [];
       };

       // Helper: Generate a unique commit ID
       private func generateCommitId(): CommitId {
           let timestamp = Int.abs(Time.now()); // Convert Int to Nat
           return Text.concat("commit-", Nat.toText(timestamp));
       };

       // Helper: Check if an array contains a Principal
       private func arrayContains(arr: [Principal], elem: Principal): Bool {
           Option.isSome(Array.find<Principal>(arr, func(p) { p == elem }));
       };

       // Create a new repository
       public shared(msg) func createRepo(name: Text, isPublic: Bool): async Result.Result<RepoId, Text> {
           let repoId = nextRepoId;
           nextRepoId += 1;

           let branches = [("main", { name = "main"; head = "" })];
           let repo: Repo = {
               id = repoId;
               name = name;
               owner = msg.caller;
               collaborators = [];
               isPublic = isPublic;
               branches = branches;
               commits = [];
           };

           repoMap.put(repoId, repo);
           #ok(repoId)
       };

       // Commit code to a branch
       public shared(msg) func commitCode(repoId: RepoId, branchName: BranchName, files: [(FilePath, Blob)], message: Text): async Result.Result<CommitId, Text> {
           switch (repoMap.get(repoId)) {
               case (null) { #err("Repository not found") };
               case (?repo) {
                   // Check permissions
                   if (repo.owner != msg.caller and not arrayContains(repo.collaborators, msg.caller) and not repo.isPublic) {
                       return #err("Permission denied");
                   };

                   let commitId = generateCommitId();
                   let tree: Tree = { files = files };
                   let commit: Commit = {
                       id = commitId;
                       tree = tree;
                       parent = switch (Array.find<(BranchName, Branch)>(repo.branches, func((name, _)) { name == branchName })) {
                           case (?(_, branch)) { ?branch.head };
                           case null { null };
                       };
                       message = message;
                       author = msg.caller;
                       timestamp = Time.now();
                   };

                   // Update branch head
                   switch (Array.find<(BranchName, Branch)>(repo.branches, func((name, _)) { name == branchName })) {
                       case (null) { return #err("Branch not found") };
                       case (?(_, branch)) {
                           let updatedBranch: Branch = { name = branchName; head = commitId };
                           let updatedBranches = Array.filter<(BranchName, Branch)>(repo.branches, func((name, _)) { name != branchName });
                           let newBranches = Array.append(updatedBranches, [(branchName, updatedBranch)]);
                           let updatedCommits = Array.append(repo.commits, [(commitId, commit)]);
                           let updatedRepo: Repo = {
                               id = repo.id;
                               name = repo.name;
                               owner = repo.owner;
                               collaborators = repo.collaborators;
                               isPublic = repo.isPublic;
                               branches = newBranches;
                               commits = updatedCommits;
                           };
                           repoMap.put(repoId, updatedRepo);
                           #ok(commitId)
                       };
                   };
               };
           };
       };

       // Create a new branch
       public shared(msg) func createBranch(repoId: RepoId, branchName: BranchName, fromBranch: BranchName): async Result.Result<(), Text> {
           switch (repoMap.get(repoId)) {
               case (null) { #err("Repository not found") };
               case (?repo) {
                   if (repo.owner != msg.caller and not arrayContains(repo.collaborators, msg.caller)) {
                       return #err("Permission denied");
                   };

                   switch (Array.find<(BranchName, Branch)>(repo.branches, func((name, _)) { name == fromBranch })) {
                       case (null) { #err("Source branch not found") };
                       case (?(_, sourceBranch)) {
                           let newBranch: Branch = { name = branchName; head = sourceBranch.head };
                           let updatedBranches = Array.append(repo.branches, [(branchName, newBranch)]);
                           let updatedRepo: Repo = {
                               id = repo.id;
                               name = repo.name;
                               owner = repo.owner;
                               collaborators = repo.collaborators;
                               isPublic = repo.isPublic;
                               branches = updatedBranches;
                               commits = repo.commits;
                           };
                           repoMap.put(repoId, updatedRepo);
                           #ok(())
                       };
                   };
               };
           };
       };

       // Merge a branch into another
       public shared(msg) func mergeBranch(repoId: RepoId, sourceBranch: BranchName, targetBranch: BranchName): async Result.Result<(), Text> {
           switch (repoMap.get(repoId)) {
               case (null) { #err("Repository not found") };
               case (?repo) {
                   if (repo.owner != msg.caller) {
                       return #err("Permission denied: Only owner can merge");
                   };

                   switch (
                       Array.find<(BranchName, Branch)>(repo.branches, func((name, _)) { name == sourceBranch }),
                       Array.find<(BranchName, Branch)>(repo.branches, func((name, _)) { name == targetBranch })
                   ) {
                       case (?(_, source), ?(_, target)) {
                           // Simplified merge: Update target branch's head to source branch's head
                           let updatedTarget: Branch = { name = targetBranch; head = source.head };
                           let updatedBranches = Array.filter<(BranchName, Branch)>(repo.branches, func((name, _)) { name != targetBranch });
                           let newBranches = Array.append(updatedBranches, [(targetBranch, updatedTarget)]);
                           let updatedRepo: Repo = {
                               id = repo.id;
                               name = repo.name;
                               owner = repo.owner;
                               collaborators = repo.collaborators;
                               isPublic = repo.isPublic;
                               branches = newBranches;
                               commits = repo.commits;
                           };
                           repoMap.put(repoId, updatedRepo);
                           #ok(())
                       };
                       case _ { #err("One or both branches not found") };
                   };
               };
           };
       };

       // Fork a repository
       public shared(msg) func forkRepo(repoId: RepoId, newRepoName: Text): async Result.Result<RepoId, Text> {
           switch (repoMap.get(repoId)) {
               case (null) { #err("Repository not found") };
               case (?repo) {
                   if (not repo.isPublic and repo.owner != msg.caller and not arrayContains(repo.collaborators, msg.caller)) {
                       return #err("Permission denied: Cannot fork private repo");
                   };

                   let newRepoId = nextRepoId;
                   nextRepoId += 1;

                   let newRepo: Repo = {
                       id = newRepoId;
                       name = newRepoName;
                       owner = msg.caller;
                       collaborators = [];
                       isPublic = repo.isPublic;
                       branches = repo.branches;
                       commits = repo.commits;
                   };

                   repoMap.put(newRepoId, newRepo);
                   #ok(newRepoId)
               };
           };
       };

       // Add a collaborator
       public shared(msg) func addCollaborator(repoId: RepoId, collaborator: Principal): async Result.Result<(), Text> {
           switch (repoMap.get(repoId)) {
               case (null) { #err("Repository not found") };
               case (?repo) {
                   if (repo.owner != msg.caller) {
                       return #err("Permission denied: Only owner can add collaborators");
                   };

                   let updatedCollaborators = Buffer.fromArray<Principal>(repo.collaborators);
                   updatedCollaborators.add(collaborator);
                   let updatedRepo: Repo = {
                       id = repo.id;
                       name = repo.name;
                       owner = repo.owner;
                       collaborators = Buffer.toArray(updatedCollaborators);
                       isPublic = repo.isPublic;
                       branches = repo.branches;
                       commits = repo.commits;
                   };
                   repoMap.put(repoId, updatedRepo);
                   #ok(())
               };
           };
       };

       // Query repository details
       public query func getRepo(repoId: RepoId): async { id: Nat; name: Text; owner: Principal; collaborators: [Principal]; isPublic: Bool } {
           switch (repoMap.get(repoId)) {
               case (null) { { id = 0; name = ""; owner = Principal.fromText("aaaaa-aa"); collaborators = []; isPublic = false } };
               case (?repo) { { id = repo.id; name = repo.name; owner = repo.owner; collaborators = repo.collaborators; isPublic = repo.isPublic } };
           };
       };

       // Query commit details
       public query func getCommit(repoId: RepoId, commitId: CommitId): async Result.Result<Commit, Text> {
           switch (repoMap.get(repoId)) {
               case (null) { #err("Repository not found") };
               case (?repo) {
                   switch (Array.find<(CommitId, Commit)>(repo.commits, func((id, _)) { id == commitId })) {
                       case (null) { #err("Commit not found") };
                       case (?(_, commit)) { #ok(commit) };
                   };
               };
           };
       };
   };
   
   //Users canisters 
   //Milestone 1,2 done
   //Milestone 3 part to be done.