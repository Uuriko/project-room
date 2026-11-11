# Clean-checkout CI runtime qualification

Source fix: `5c8e03d8f`. Production runtime and every existing test assertion are unchanged.

The two historical tests named local-only commits absent from GitHub checkout history. They now archive full, published main ancestors: `29beafbdb53309d0cc0c3e11f7d6e42b7cb181ed` (genuine `normalized-current-v1-native-work-5`) and `46bd0e7b3e95270b5b1b532ed511b76a7481ce0d` (genuine restore audit protocol 18). These are real prior runtimes, not current code with edited constants. The original native5 warm/cold/prepared-writer refusals and old18 zero-DROP/no-progress/exact continuation controls remain intact.

A new temporary Git repository fetched release `328928e275e05b950b8f4e7bd6ec9bcf42cc03f5` and those two published objects directly from `https://github.com/Uuriko/project-room.git`, without local object sharing. The original two tests failed because `74d252de9` and `a82574def` were absent. Copying only the revised two test files into that checkout yielded **2/2 pass**, zero skips. Root npm dependencies were symlinked from the existing local install; Git history was fetched independently.

The same checkout reproduced the actual offline-archive Native test's `ENOENT` for `cloudflare/node_modules`. The unit workflow now uses the same pinned pnpm v4 action, pnpm major 10, frozen Cloudflare lockfile and cache as the existing Cloudflare job before executing the unchanged unit suite. The Native test remains executed, not skipped or replaced with a mock. The native package source remains exact release328; workflow/test-only changes do not change production package bytes.

Existing workflow contract controls: **5/5 pass**. Targeted ESLint: **0 errors**, one pre-existing `prefer-const` warning in the unchanged report fixture. No whole Node suite was repeated. This is local macOS qualification; a fresh Linux GitHub job is still required to confirm runner-specific behavior. These fixes do not certify whole recovery boundedness: the required original final audit remains in place.

Exact workflow major-version validation: a **new** Cloudflare dependency directory was installed with **pnpm 10.34.9**, `--frozen-lockfile --ignore-scripts`, from the retained lockfile. The actual packaged Native test then passed **1/1, zero skips**, in 73385.3765 ms (wall clock). The receipt retains **1118 recovery continuations, 144 cleanup calls, 6096 covered rows, 52 cold restarts**, original full independent audit, exact retries, prepared-writer denial, private request preservation and final cold-ready checks. The verified offline archive remained unchanged. An earlier supplementary install with the machine-default pnpm11 also passed; the final retained result uses the workflow's pnpm10 major.

Captured logs normalize trailing whitespace only.
