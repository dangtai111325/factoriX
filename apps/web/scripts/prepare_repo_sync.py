import os
import shutil

SRC = r"c:\Users\Ave-T14-001\Desktop\FactoriX\iiot-frontend"
DEST_REPO = r"c:\Users\Ave-T14-001\Desktop\FactoriX\branch\frontend-gravity"

def sync_repo():
    print("Synchronizing FactoriX frontend into git repository...")
    
    # Target 1: iiot-frontend directory in repo
    dest_iiot = os.path.join(DEST_REPO, "iiot-frontend")
    if os.path.exists(dest_iiot):
        shutil.rmtree(dest_iiot)
    os.makedirs(dest_iiot, exist_ok=True)
    
    ignore_patterns = shutil.ignore_patterns(
        "*HANDOFF*",
        "*handoff*",
        "FACTORIX_IIOT_COMPLETE_DESIGN_HANDOFF_V7",
        "node_modules",
        ".git",
        "dist",
        "crops",
        "crops_features",
        "user_review_qa"
    )
    
    for item in os.listdir(SRC):
        if "HANDOFF" in item.upper() or item in ["node_modules", ".git", "dist"]:
            print(f"  [SKIPPED] {item}")
            continue
        s_path = os.path.join(SRC, item)
        d_path = os.path.join(dest_iiot, item)
        if os.path.isdir(s_path):
            shutil.copytree(s_path, d_path, ignore=ignore_patterns)
            print(f"  [COPIED DIR] {item} -> iiot-frontend/{item}")
        else:
            shutil.copy2(s_path, d_path)
            print(f"  [COPIED FILE] {item} -> iiot-frontend/{item}")

    # Target 2: Copy artifacts to repo root artifacts/visual_qa
    dest_artifacts = os.path.join(DEST_REPO, "artifacts", "visual_qa")
    os.makedirs(dest_artifacts, exist_ok=True)
    src_artifacts = os.path.join(SRC, "artifacts", "visual_qa_v2")
    if os.path.exists(src_artifacts):
        for f in os.listdir(src_artifacts):
            if f.endswith(".png") or f.endswith(".html"):
                shutil.copy2(os.path.join(src_artifacts, f), os.path.join(dest_artifacts, f))
        print(f"  [COPIED EVIDENCE] {len(os.listdir(dest_artifacts))} files to artifacts/visual_qa/")

    # Target 3: Update apps/web
    dest_web = os.path.join(DEST_REPO, "apps", "web")
    os.makedirs(dest_web, exist_ok=True)
    # copy src
    dest_web_src = os.path.join(dest_web, "src")
    if os.path.exists(dest_web_src):
        shutil.rmtree(dest_web_src)
    shutil.copytree(os.path.join(SRC, "src"), dest_web_src)
    # copy public
    dest_web_public = os.path.join(dest_web, "public")
    if os.path.exists(dest_web_public):
        shutil.rmtree(dest_web_public)
    shutil.copytree(os.path.join(SRC, "public"), dest_web_public)
    # copy config files
    for cf in ["package.json", "index.html", "vite.config.ts", "tsconfig.json", "tailwind.config.js", "postcss.config.js"]:
        src_cf = os.path.join(SRC, cf)
        if os.path.exists(src_cf):
            shutil.copy2(src_cf, os.path.join(dest_web, cf))
    print("  [UPDATED] apps/web synchronized with latest FactoriX UI")

    # Safety check: Verify no handoff files exist
    print("Running Safety Audit: checking for any handoff references...")
    violation_found = False
    for root, dirs, files in os.walk(DEST_REPO):
        for d in dirs:
            if "HANDOFF" in d.upper():
                print("  [ERROR] Found handoff directory:", os.path.join(root, d))
                violation_found = True
        for f in files:
            if "HANDOFF" in f.upper():
                print("  [ERROR] Found handoff file:", os.path.join(root, f))
                violation_found = True
    if not violation_found:
        print("  [AUDIT PASSED] Zero handoff files present in destination repository.")

if __name__ == "__main__":
    sync_repo()
