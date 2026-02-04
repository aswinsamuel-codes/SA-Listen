import shutil
import os

files_to_move = ['index.html', 'style.css', 'script.js']
dir_to_move = 'test'
target_dir = 'sa-listen-ui'

if not os.path.exists(target_dir):
    os.makedirs(target_dir)
    print(f"Created {target_dir}")

for f in files_to_move:
    if os.path.exists(f):
        try:
            shutil.move(f, target_dir)
            print(f"Moved {f}")
        except Exception as e:
            print(f"Error moving {f}: {e}")
    else:
        print(f"File {f} not found")

if os.path.exists(dir_to_move):
    try:
        shutil.move(dir_to_move, target_dir)
        print(f"Moved {dir_to_move}")
    except Exception as e:
        print(f"Error moving {dir_to_move}: {e}")
else:
    print(f"Dir {dir_to_move} not found")
