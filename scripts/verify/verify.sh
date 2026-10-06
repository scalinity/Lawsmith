#!/bin/zsh
# Lawsmith verification entry point, so a session reruns checks instead of reconstructing them.
#
#   scripts/verify/verify.sh unit            typecheck, Vitest, and the native Rust tests
#   scripts/verify/verify.sh build           the packaged Lawsmith.app
#   scripts/verify/verify.sh native NAME     native scenario scripts/verify/native/NAME.zsh against
#                                            the packaged app; needs QA_STATE (disposable state) and
#                                            QA_OUT (logs and captures). See native/lib.zsh.
set -e
cd ${0:A:h:h:h}
case $1 in
  unit)
    npm run typecheck
    npm test
    (cd src-tauri && cargo test)
    ;;
  build) npx tauri build --bundles app ;;
  native)
    : ${QA_STATE:?set QA_STATE to a disposable directory} ${QA_OUT:?set QA_OUT to an output directory}
    zsh scripts/verify/native/$2.zsh
    ;;
  *) print -u2 "usage: verify.sh unit | build | native NAME"; exit 2 ;;
esac
