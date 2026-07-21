/**
 * Generates TypeScript (ts-proto) bindings for every .proto file in
 * libs/proto/src, using the protoc binary bundled with grpc-tools
 * (node_modules/grpc-tools/bin) instead of relying on a system-wide
 * protoc install. This keeps `npm run proto:gen` working on machines
 * (including this Windows dev box) that don't have protoc on PATH.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const protoSrcDir = path.join(rootDir, 'libs', 'proto', 'src');
const outDir = path.join(protoSrcDir, 'generated');

fs.mkdirSync(outDir, { recursive: true });

const protoFiles = fs
  .readdirSync(protoSrcDir)
  .filter((f) => f.endsWith('.proto'));

if (protoFiles.length === 0) {
  console.log('No .proto files found in libs/proto/src, skipping codegen.');
  process.exit(0);
}

// IMPORTANT: grpc-tools must stay pinned at exactly 1.9.1 (see package.json) on Windows.
// 1.10+ ships a debug build of protoc.exe that requires ucrtbased.dll (the Debug Universal
// C Runtime), which is not present outside a full Visual Studio debug-tools install and
// fails with "error while loading shared libraries: ucrtbased.dll: cannot open shared
// object file". Do not bump grpc-tools past 1.9.1 without re-verifying protoc.exe still
// runs standalone on a plain Windows dev machine.
const protocBin = process.platform === 'win32' ? 'protoc.exe' : 'protoc';
const protocPath = path.join(rootDir, 'node_modules', 'grpc-tools', 'bin', protocBin);

if (!fs.existsSync(protocPath)) {
  console.error(
    `protoc binary not found at ${protocPath}. Ensure grpc-tools is installed (npm i -D grpc-tools).`,
  );
  process.exit(1);
}

const tsProtoPlugin = path.join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'protoc-gen-ts_proto.cmd' : 'protoc-gen-ts_proto',
);

const args = [
  `--plugin=protoc-gen-ts_proto=${tsProtoPlugin}`,
  `--ts_proto_out=${outDir}`,
  '--ts_proto_opt=nestJs=true,addGrpcMetadata=true,outputServices=grpc-js',
  `--proto_path=${protoSrcDir}`,
  ...protoFiles.map((f) => path.join(protoSrcDir, f)),
];

execFileSync(protocPath, args, { stdio: 'inherit' });

console.log(
  `proto:gen: generated ${protoFiles.length} proto file(s) into ${path.relative(rootDir, outDir)}`,
);
