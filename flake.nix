{
  description = "fractal - HTTP/RPC/IPC API library with composition via combinators";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # JS/TS runtime (project + generated TS/JS variants)
            nodejs_20
            bun

            # Python (dataclass, pydantic, attrs projectors)
            python3

            # Go (encoding/json projector)
            go

            # Rust (serde projector)
            rustc
            cargo

            # Java (Jackson, Gson, Moshi projectors) + Kotlin (kotlinx projector)
            jdk
            kotlin

            # C#/.NET (System.Text.Json, Newtonsoft projectors)
            dotnet-sdk

            # Ruby (Sorbet projector)
            ruby

            # PHP (native projector)
            php

            # Haskell (Aeson projector)
            ghc

            # C++ (nlohmann projector) — gcc/g++ via stdenv, plus the header-only library
            nlohmann_json

            # Dart (json_serializable, freezed projectors)
            dart

            # Elm (json projector)
            elmPackages.elm

            # Crystal (json-serializable projector)
            crystal

            # Swift (Codable projector) — swift-wrapper builds and runs fine on Linux in nixpkgs
            swift

            # Flow (native projector) — flow-bin equivalent, packaged in nixpkgs
            flow

            # Objective-C (Foundation projector) — GNUstep provides Foundation on Linux;
            # no single "objc compiler" package, gcc/clang (via stdenv) provide the
            # compiler and gnustep-base/gnustep-make provide the Foundation runtime.
            gnustep-base
            gnustep-make

            # Schema/IDL compilers used to validate generated wire-format code
            protobuf # protoc
            capnproto # capnp
            flatbuffers # flatc
          ];
        };
      }
    );
}
