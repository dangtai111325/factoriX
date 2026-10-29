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
    print("=== Step 1: Wipe everything in git repo except .git ===")
    for item in os.listdir(REPO):
        if item == ".git":
            continue
        p = os.path.join(REPO, item)
        if os.path.isdir(p):
            shutil.rmtree(p)
        else:
            os.remove(p)
    print("Repo worktree wiped clean.")

    print("\n=== Step 2: Switch to orphan clean branch ===")
    # Create orphan branch so it has zero parent commits and zero monorepo baggage
    run_cmd("git checkout --orphan temp-clean-frontend")
    run_cmd("git reset --hard")

    print("\n=== Step 3: Copy all contents of iiot-frontend directly to repo root ===")
    for item in os.listdir(SRC):
        if item in EXCLUDE_DIRS or "HANDOFF" in item.upper():
            print(f"  [SKIPPED] {item}")
            continue

        src_item = os.path.join(SRC, item)
        dst_item = os.path.join(REPO, item)

        if os.path.isdir(src_item):
            shutil.copytree(src_item, dst_item, ignore=shutil.ignore_patterns(
                "*HANDOFF*", "*handoff*", "node_modules", "dist", ".git"
            ))
            print(f"  [COPIED DIR]  {item}/")
        else:
            shutil.copy2(src_item, dst_item)
            print(f"  [COPIED FILE] {item}")

    # Ensure a robust .gitignore exists at the repo root
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

    print("\n=== Step 5: Git commit & Branch replace ===")
    run_cmd("git add -A")
    run_cmd('git commit -m "feat(frontend): clean release of FactoriX IIoT frontend platform with V7 UI/UX & 49 mockup enhancements"')
    run_cmd("git branch -M new-frontend")

    print("\n=== Step 6: Force push clean branch to origin new-frontend ===")
    run_cmd("git push origin new-frontend --force")

    print("\n=== Step 7: Final Verification ===")
    out = run_cmd("git log -n 1 --stat")
    print(out)
    print("SUCCESS! Clean push complete!")

if __name__ == "__main__":
    main()
