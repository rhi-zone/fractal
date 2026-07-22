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

            # Python (dataclass projector: stdlib only; pydantic/attrs projectors:
            # real libraries pulled in here so compile-check.test.ts can actually
            # import the generated modules, not just parse them)
            (python3.withPackages (ps: [ ps.pydantic ps.attrs ]))

            # Go (encoding/json, easyjson projectors — both stdlib-only: easyjson's
            # own runtime is only needed by its code-*generator*, not by the
            # struct/tag output this repo's projector emits)
            go

            # Rust (serde projector) — compile-check.test.ts builds a real temp
            # Cargo project against serde+serde_json, so this needs network
            # access to crates.io at test time (same as any `cargo build`).
            rustc
            cargo

            # Java (Jackson, Gson, Moshi projectors) + Kotlin (kotlinx projector)
            # NOTE: compile-check.test.ts does NOT compile these against the real
            # Jackson/Gson/Moshi/kotlinx-serialization libraries — those aren't
            # single nixpkgs derivations (they're Maven/Gradle-resolved jars) and
            # aren't otherwise vendored here, so those checks are `test.skip` with
            # a comment. jdk/kotlin stay for the toolchain's other consumers.
            jdk
            kotlin

            # C#/.NET — System.Text.Json ships in the runtime itself (no NuGet
            # package needed), so csharp-systemtextjson gets a real `dotnet build`
            # check. csharp-newtonsoft needs the Newtonsoft.Json NuGet package,
            # which isn't vendored here, so it's `test.skip`.
            dotnet-sdk

            # Ruby (Sorbet, dry-types projectors) — `ruby -c` is a syntax-only
            # check (it never executes `require`), so no gem install is needed
            # for either variant to get a real check.
            ruby

            # PHP (native projector) — `php -l` is likewise syntax-only.
            php

            # Haskell (Aeson projector) — `ghc -fno-code` needs a real `aeson`
            # module to resolve `import Data.Aeson`, so this is `ghcWithPackages`
            # (fetched prebuilt from cache.nixos.org) rather than bare `ghc`.
            (haskellPackages.ghcWithPackages (ps: [ ps.aeson ps.text ]))

            # C++ (nlohmann projector) — gcc/g++ via stdenv, plus the header-only library
            nlohmann_json

            # Dart (json_serializable, freezed projectors) — both need
            # pub.dev-hosted build_runner-generated companion files
            # (`*.g.dart`/`*.freezed.dart`) that this repo's projector output
            # references but doesn't itself emit, so both are `test.skip`.
            dart

            # Elm (json projector) — `elm make` resolves `elm/json` through
            # Elm's own package registry, which isn't vendored here, so this is
            # `test.skip`.
            elmPackages.elm

            # Crystal (json-serializable projector) — JSON::Serializable is
            # stdlib, real `crystal build --no-codegen` check.
            crystal

            # Swift (Codable projector) — swift-wrapper builds and runs fine on Linux in nixpkgs
            swift

            # Flow (native projector) — flow-bin equivalent, packaged in nixpkgs
            flow

            # Objective-C (Foundation projector) — GNUstep provides Foundation on
            # Linux; plain gcc here has no Objective-C frontend at all ("objc
            # compiler not installed"), so `clang` (which nixpkgs' gnustep setup
            # targets) is what actually compiles the generated .m files.
            clang
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
