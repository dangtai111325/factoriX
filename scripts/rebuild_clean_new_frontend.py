import os
import shutil
import subprocess

SRC = r"C:\Users\Ave-T14-001\Desktop\FactoriX\iiot-frontend"
REPO = r"C:\Users\Ave-T14-001\Desktop\FactoriX\branch\frontend-gravity"

EXCLUDE_DIRS = {
    "FACTORIX_IIOT_COMPLETE_DESIGN_HANDOFF_V7",
    "node_modules",
    "dist",
    ".git"
}

def run_cmd(cmd, cwd=REPO):
    print(f"Running: {cmd}")
    res = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    if res.stdout:
        print(res.stdout.strip())
    if res.stderr:
        print(f"STDERR: {res.stderr.strip()}")
    if res.returncode != 0:
        raise Exception(f"Command failed with code {res.returncode}")
    return res.stdout

def main():
    print("=== Step 1: Ensure on new-frontend branch ===")
    run_cmd("git checkout new-frontend")

    print("\n=== Step 2: Wipe all tracked and untracked files in worktree except .git ===")
    for item in os.listdir(REPO):
        if item == ".git":
            continue
        p = os.path.join(REPO, item)
        if os.path.isdir(p):
            shutil.rmtree(p)
        else:
            os.remove(p)
    print("Worktree wiped clean.")

    print("\n=== Step 3: Copy all contents of iiot-frontend directly to repo root ===")
    for item in os.listdir(SRC):
        if item in EXCLUDE_DIRS or "HANDOFF" in item.upper():
            print(f"  [SKIPPED] {item}")
            continue

        src_item = os.path.join(SRC, item)
        dst_item = os.path.join(REPO, item)

        if os.path.isdir(src_item):
            shutil.copytree(src_item, dst_item, ignore=shutil.ignore_patterns(
                "*HANDOFF*", "*handoff*", "node_modules", "dist", ".git", "*.traineddata"
            ))
            print(f"  [COPIED DIR]  {item}/")
        else:
            shutil.copy2(src_item, dst_item)
            print(f"  [COPIED FILE] {item}")

    # Ensure robust .gitignore exists at the repo root
    gitignore_content = """# Dependencies
node_modules/
.pnp
.pnp.js

# Production build
dist/
build/

# Environment and local configs
.env
.env.local
.env.*.local

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
*.log

# Editor and OS
.vscode/
.idea/
.DS_Store
Thumbs.db

# Large OCR training binaries
*.traineddata

# Handoff exclusion (strict)
*HANDOFF*
*handoff*
FACTORIX_IIOT_COMPLETE_DESIGN_HANDOFF_V7/
"""
    with open(os.path.join(REPO, ".gitignore"), "w", encoding="utf-8") as f:
        f.write(gitignore_content)
    print("  [CREATED] .gitignore")

    print("\n=== Step 4: Safety Audit for Handoff ===")
    violations = []
    for root, dirs, files in os.walk(REPO):
        if ".git" in root:
            continue
        for d in dirs:
            if "handoff" in d.lower():
                violations.append(os.path.join(root, d))
        for f in files:
            if "handoff" in f.lower():
                violations.append(os.path.join(root, f))
    if violations:
        raise Exception(f"CRITICAL SAFETY VIOLATION: Found handoff items: {violations}")
    print("Safety Audit Passed: Zero handoff files present.")

    print("\n=== Step 5: Git stage & commit ===")
    run_cmd("git add -A")
    status_out = run_cmd("git status --porcelain")
    if status_out.strip():
        run_cmd('git commit -m "feat(frontend): apply expert review v2 overhaul across all 15 screens, demo mode, and contracts"')
    else:
        print("No changes to commit.")

    print("\n=== Step 6: Push to origin new-frontend ===")
    run_cmd("git push origin new-frontend")

    print("\n=== Step 7: Final Verification ===")
    out = run_cmd("git log -n 2 --stat")
    print(out)
    print("SUCCESS! Clean push complete!")

if __name__ == "__main__":
    main()
