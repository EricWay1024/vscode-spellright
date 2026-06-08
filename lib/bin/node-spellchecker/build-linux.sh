#!/bin/bash

# requires node-gyp (npm install -g node-gyp) plus CLI developper tools.

# VS Code Server (used by Remote-WSL/Remote-SSH) runs the extension host on
# stock Node, not Electron, so we also build against a Node target. Update
# the version below to match `~/.vscode-server/bin/<hash>/node --version`
# when VS Code ships a new Node runtime.
npx node-gyp rebuild --target=24.15.0 --arch=x64
cp build/Release/spellchecker.node ../spellchecker-linux-node24.15.0-x64.node

npx node-gyp rebuild --target=39.2.3 --arch=x64 --dist-url=https://electronjs.org/headers
cp build/Release/spellchecker.node ../spellchecker-linux-39.2.3-x64.node

npx node-gyp rebuild --target=39.2.3 --arch=ia32 --dist-url=https://electronjs.org/headers
cp build/Release/spellchecker.node ../spellchecker-linux-39.2.3-ia32.node

npx node-gyp rebuild --target=37.2.3 --arch=x64 --dist-url=https://electronjs.org/headers
cp build/Release/spellchecker.node ../spellchecker-linux-37.2.3-x64.node

npx node-gyp rebuild --target=37.2.3 --arch=ia32 --dist-url=https://electronjs.org/headers
cp build/Release/spellchecker.node ../spellchecker-linux-37.2.3-ia32.node
