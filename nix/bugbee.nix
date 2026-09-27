{
  lib,
  stdenvNoCC,
  callPackage,
  bun,
  nodejs,
  sysctl,
  makeBinaryWrapper,
  models-dev,
  ripgrep,
  installShellFiles,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  node_modules ? callPackage ./node-modules.nix { },
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "bugbee";
  inherit (node_modules) version src;
  inherit node_modules;

  nativeBuildInputs = [
    bun
    nodejs # for patchShebangs node_modules
    installShellFiles
    makeBinaryWrapper
    models-dev
    writableTmpDirAsHomeHook
  ];

  postPatch = ''
    # NOTE: Relax Bun version check to be a warning instead of an error
    substituteInPlace packages/script/src/index.ts \
      --replace-fail 'throw new Error(`This script requires bun@''${expectedBunVersionRange}' \
                     'console.warn(`Warning: This script requires bun@''${expectedBunVersionRange}'
  '';

  configurePhase = ''
    runHook preConfigure

    cp -R ${finalAttrs.node_modules}/. .
    patchShebangs node_modules
    patchShebangs packages/*/node_modules

    runHook postConfigure
  '';

  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.BUGBEE_DISABLE_MODELS_FETCH = true;
  env.BUGBEE_VERSION = finalAttrs.version;
  env.BUGBEE_CHANNEL = "prod";

  buildPhase = ''
    runHook preBuild

    cd ./packages/bugbee
    bun --bun ./script/build.ts --single --skip-install
    bun --bun ./script/schema.ts schema.json

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/bugbee-*/bin/bugbee $out/bin/bugbee
    install -Dm644 schema.json $out/share/bugbee/schema.json

    wrapProgram $out/bin/bugbee \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            ripgrep
          ]
          # bun runs sysctl to detect if running on rosetta2
          ++ lib.optional stdenvNoCC.hostPlatform.isDarwin sysctl
        )
      }

    runHook postInstall
  '';

  postInstall = lib.optionalString (stdenvNoCC.buildPlatform.canExecute stdenvNoCC.hostPlatform) ''
    # trick yargs into also generating zsh completions
    installShellCompletion --cmd bugbee \
      --bash <($out/bin/bugbee completion) \
      --zsh <(SHELL=/bin/zsh $out/bin/bugbee completion)
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = [ "HOME" "BUGBEE_DISABLE_MODELS_FETCH" ];
  versionCheckProgramArg = "--version";

  passthru = {
    jsonschema = "${placeholder "out"}/share/bugbee/schema.json";
    env = finalAttrs.env;
  };

  meta = {
    description = "The open source coding agent";
    homepage = "https://github.com/sajadinmaker/bugbee";
    license = lib.licenses.mit;
    mainProgram = "bugbee";
    inherit (node_modules.meta) platforms;
  };
})
