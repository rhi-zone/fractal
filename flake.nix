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
            # import the generated modules, not just parse them; sphinx: NOT used
            # by any committed test — pulled in for one-time local visual
            # verification of sphinx-reference.ts's generated .rst output via a
            # real `sphinx-build` run (docs/roadmap.md's doc-generator "basics"
            # bar D), same precedent as pydantic/attrs above but for a doc
            # projector's rendered-HTML output instead of a compiled module; not
            # wired into CI or any required test gate, per bar C being out of
            # scope for this initiative; mkdocs/mkdocs-material: same precedent,
            # same not-CI-gated status, for mkdocs-vanilla-reference.ts's and
            # mkdocs-reference.ts's own bar-D `mkdocs build --strict` local
            # verification runs — both packages are pulled in together since the
            # two targets are genuinely separate `mkdocs.yml` themes (plain
            # `mkdocs` vs. `mkdocs-material`), not one target with an optional
            # extra); docutils/pygments: same not-CI-gated precedent again, for
            # docutils-reference.ts's own bar-D `rst2html --report=2` local
            # verification run — docutils is Sphinx's own parser dependency, so
            # `ps.sphinx` above already carries it transitively, but the plain
            # `docutils-reference.ts` target is checked against the standalone
            # `docutils` package/CLI (`rst2html`/`rst2html5`) directly, not
            # through Sphinx; pygments is added alongside it because it's an
            # optional, not required, docutils dependency (unlike Sphinx, which
            # bundles Pygments itself) — without it, every `.. code::` block
            # emits a "Cannot analyze code. Pygments package not found." WARNING,
            # which would fail a warnings-as-errors bar-D run for a reason that
            # has nothing to do with this projector's actual output being wrong)
            (python3.withPackages (ps: [
              ps.pydantic
              ps.attrs
              ps.sphinx
              ps.mkdocs
              ps.mkdocs-material
              ps.docutils
              ps.pygments
            ]))

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
            # check. csharp-newtonsoft resolves Newtonsoft.Json for real from
            # nuget.org at test time (`dotnet add package`) — dotnet-sdk already
            # bundles the NuGet client, so no extra buildInput is needed for it.
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

            # Gleam (ffi-ir's gleam-external `@external` projector) — real
            # `gleam build` check for ffi-ir's compile-check suite.
            gleam

            # Deno (ffi-ir's typescript-deno Deno.dlopen-based projector) —
            # real `deno check`/`deno run --check` check for ffi-ir's
            # compile-check suite.
            deno

            # wasm-tools (ffi-ir's wit projector) — `wasm-tools component wit`
            # gives a real WIT-source parse/validate check for ffi-ir's
            # compile-check suite, without needing a full component-model
            # toolchain (wit-bindgen etc., not packaged in nixpkgs).
            wasm-tools

            # OCaml + dune + Melange (ffi-ir's ocaml-melange `external`
            # projector) — `dune build` against a real `(melange.emit)`
            # stanza gives a real compile check for ffi-ir's compile-check
            # suite. ocamlPackages.melange pulls in Melange's own PPX/runtime;
            # dune drives the actual build.
            ocamlPackages.ocaml
            ocamlPackages.dune_3
            ocamlPackages.melange
            ocamlPackages.findlib

            # Elixir (Jason projector) — staged for a future real compile
            # check, not wired up yet: unlike Ruby's `ruby -c` (a true
            # parse-only check that never expands macros), Elixir has no
            # syntax-only mode — `@derive Jason.Encoder` is a compile-time
            # macro that dispatches into the real `Jason.Encoder` protocol
            # during compilation, so `elixirc` can't even parse-check the
            # generated struct module without the `jason` Hex package
            # resolvable on the code path. nixpkgs ships plain `elixir` here
            # (no curated Hex package set the way `haskellPackages.ghcWithPackages`
            # curates Haskell's), so `jason` would need `mix`-based dependency
            # fetching (network access + a `mix.exs` project) that isn't
            # vendored/wired up here yet — see compile-check.test.ts's
            # elixir-jason skip comment for the exact follow-up.
            beamPackages.elixir

            # Schema/IDL compilers used to validate generated wire-format code
            protobuf # protoc
            capnproto # capnp
            flatbuffers # flatc

            # Emacs (org-mode-reference.ts's target ecosystem) — NOT used by
            # any committed test — pulled in for one-time local visual
            # verification of org-mode-reference.ts's generated .org output,
            # via a real `emacs --batch` load of `org` plus `org-lint` and an
            # `org-export-to-html` run (docs/roadmap.md's doc-generator
            # "basics" bar D), same not-CI-gated precedent as sphinx/mkdocs
            # above. `emacs-nox` (no GUI toolkit) is enough for a batch-mode
            # check; `org` itself ships bundled with Emacs since 24.x, no
            # separate package needed.
            emacs-nox
          ];
        };
      }
    );
}
