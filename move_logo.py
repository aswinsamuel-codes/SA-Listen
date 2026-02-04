import shutil
import os

source = r"C:\Users\Admin\.gemini\antigravity\brain\cfe91c65-969c-44c7-aac1-cb69b3cdcf52\uploaded_media_1770231996742.png"
dest_dir = r"d:\MY works\Hello World\SA listen\logo"
dest_file = os.path.join(dest_dir, "banner.png")

print(f"Attempting to copy {source} to {dest_file}")

try:
    if not os.path.exists(source):
        print("Source file does not exist!")
    else:
        shutil.copy2(source, dest_file)
        print("Copy successful!")
except Exception as e:
    print(f"Error: {e}")
