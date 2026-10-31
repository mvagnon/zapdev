# Changelog

## [5.3.0](https://github.com/mvagnon/zapdev/compare/v5.2.0...v5.3.0) (2026-10-31)


### Features

* Add optional fallback for resource resolution and propagate to prep ([8dbda4d](https://github.com/mvagnon/zapdev/commit/8dbda4d1d39cf0c03a59d69e954dfd930451b762))
* **cli:** Open interactive command menu and route explicit or legacy commands. ([12f5253](https://github.com/mvagnon/zapdev/commit/12f52532754b875413fa515f24bce171875ccbe7))
* **update-repo:** Add update-repo command to fast-forward repositories from their remotes without discarding local work. ([c7ec917](https://github.com/mvagnon/zapdev/commit/c7ec91726da2d9291124143d54ab8fe0e3f653f7))
* **update-repo:** Update repositories on the chosen branch; '*' keeps current branches and fetches origin. ([46f0f0b](https://github.com/mvagnon/zapdev/commit/46f0f0b60a765622eaa178bae71f58a5df4afbd4))
* **workspace-config:** Introduce modular repo/worktree preparation and workspace config system ([6fa8dc6](https://github.com/mvagnon/zapdev/commit/6fa8dc6219476a548095edec2a38c53fb30de347))


### Bug Fixes

* Allow cleanup from a targeted worktree or its subdirectory ([5a43cea](https://github.com/mvagnon/zapdev/commit/5a43cea80f759fe61a63d07516c551627a9870ae))
* **cli:** Remove implicit default commit mapping in the CLI and update help and error text. ([d1e862e](https://github.com/mvagnon/zapdev/commit/d1e862eaf1961802618c60b9637532c413851ae6))
* **worktrees:** Remove the parent workspace after the last worktree cleanup if it becomes empty or contains only symlinks. ([9c4d5b7](https://github.com/mvagnon/zapdev/commit/9c4d5b798178c9f06b0a43d1689ef4ca7ec6497e))

## [5.2.0](https://github.com/mvagnon/zapdev/compare/v5.1.0...v5.2.0) (2026-10-25)


### Features

* **worktrees:** Discover repositories from a path and perform worktree cleanup. ([c445e36](https://github.com/mvagnon/zapdev/commit/c445e363b8d0c9230cc469fd1de98c97af99d540))


### Bug Fixes

* **pr:** Add JSON output for PRs and worktree cleanup results ([bf62815](https://github.com/mvagnon/zapdev/commit/bf628154c3639b4baa7dfd23dadb8f509096b6bc))

## [5.1.0](https://github.com/mvagnon/zapdev/compare/v5.0.0...v5.1.0) (2026-10-22)


### Features

* **pr:** Publish PRs for the current repo or direct child repos using AI titles. ([ccae261](https://github.com/mvagnon/zapdev/commit/ccae2612823a5e58b70595e3ba8788578ecae887))

## [5.0.0](https://github.com/mvagnon/zapdev/compare/v4.0.0...v5.0.0) (2026-10-21)


### ⚠ BREAKING CHANGES

* Adds PR command to commit and create GitHub pull request

### Features

* Adds PR command to commit and create GitHub pull request ([f251ec6](https://github.com/mvagnon/zapdev/commit/f251ec67189f624dfd4528612b0747b64af18b70))
* Adds rule to markdown files to disallow missing label references except for '!TIP' ([ce08552](https://github.com/mvagnon/zapdev/commit/ce08552781798a8dd9c54e57f0b8d8b04ae13bfa))


### Bug Fixes

* Added test for pr command ([8fff2d9](https://github.com/mvagnon/zapdev/commit/8fff2d9e1b648a52a549a13e0ee7a5b50897b6ba))
* Updated README with tip on using zapdev-mcp ([fe57c5e](https://github.com/mvagnon/zapdev/commit/fe57c5e6ded7f45ade58dba14dfecc6bb7355edb))

## [4.0.0](https://github.com/mvagnon/zapdev/compare/v3.4.1...v4.0.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* introduce structured outputs

### Features

* introduce structured outputs ([94b501d](https://github.com/mvagnon/zapdev/commit/94b501d3f37dd909235011583d23b86f8195253e))


### Bug Fixes

* Added new fields and tests for commit message generation ([fc40a52](https://github.com/mvagnon/zapdev/commit/fc40a52cb019bda1178f5b5b163499857166ab6b))

## [3.4.1](https://github.com/mvagnon/zapdev/compare/v3.4.0...v3.4.1) (2026-10-17)


### Bug Fixes

* improve handling of provider errors by preserving HTTP status and details ([fd7aa2d](https://github.com/mvagnon/zapdev/commit/fd7aa2d34763966c614f10d5350baa1ee898b497))
* **README:** update URL in documentation for Chat Completions endpoint ([2ac0dcd](https://github.com/mvagnon/zapdev/commit/2ac0dcd3473e8241dd627ad83b584c221d31afab))

## [3.4.0](https://github.com/mvagnon/zapdev/compare/v3.3.0...v3.4.0) (2026-10-12)


### Features

* **commit:** add auto type option and skip breaking prompt for auto ([1af66fc](https://github.com/mvagnon/zapdev/commit/1af66fcc162d8dc2f79ce20af1041fc45dd0fac2))
* **commit:** add retry with validation feedback for invalid messages ([1ae0c0d](https://github.com/mvagnon/zapdev/commit/1ae0c0db96cb59c9e4683ac349eddc3cc1b19b9b))
* relax the 72-character limit to a guideline and remove length validation ([f9bb71c](https://github.com/mvagnon/zapdev/commit/f9bb71ce4164e1ace6bfc2b6f61a989803c39b18))

## [3.3.0](https://github.com/mvagnon/zapdev/compare/v3.2.1...v3.3.0) (2026-10-12)


### Features

* add error management ([2bb572b](https://github.com/mvagnon/zapdev/commit/2bb572b4dd1c8fc87f24d4df26bb04ac8fd7f23e))

## [3.2.1](https://github.com/mvagnon/zapdev/compare/v3.2.0...v3.2.1) (2026-10-12)


### Bug Fixes

* show LLM error ([0587303](https://github.com/mvagnon/zapdev/commit/0587303b0e1388c7c69f8ff6468eda149378ce16))
* **test:** content-type ([71569ae](https://github.com/mvagnon/zapdev/commit/71569aeaec0588d8b9a150d4cae383984ba88e60))

## [3.2.0](https://github.com/mvagnon/zapdev/compare/v3.1.2...v3.2.0) (2026-10-12)


### Features

* support for API auth ([2870836](https://github.com/mvagnon/zapdev/commit/28708362a79443b423b5c9fe899be4371ee97dc4))

## [3.1.2](https://github.com/mvagnon/zapdev/compare/v3.1.1...v3.1.2) (2026-10-11)


### Bug Fixes

* **context:** truncate oversized inventories instead of throwing error ([8dbeff0](https://github.com/mvagnon/zapdev/commit/8dbeff000e2d1489a3645a6eeb2e0469f1368780))

## [3.1.1](https://github.com/mvagnon/zapdev/compare/v3.1.0...v3.1.1) (2026-10-11)


### Bug Fixes

* **llm:** improve commit message generation pipeline ([755af78](https://github.com/mvagnon/zapdev/commit/755af787f9d4ea60ad9d8ff2c3eca81f4c810507))

## [3.1.0](https://github.com/mvagnon/zapdev/compare/v3.0.2...v3.1.0) (2026-10-11)


### Features

* Integrate configurable commit types and prompts ([de2add6](https://github.com/mvagnon/zapdev/commit/de2add65c5b37fc0aaaf2ec722286c36a7235f09))


### Bug Fixes

* Enhance command flags and improve prompts for commits ([9ef7260](https://github.com/mvagnon/zapdev/commit/9ef726075b4713a289b43c3b7293879d9c0c8099))
* **zapdev:** Update CLI help text and prompt logic for clarity ([6a57f91](https://github.com/mvagnon/zapdev/commit/6a57f91acea0f1d09e6aa96f833e0e6f9bfefd49))

## [3.0.2](https://github.com/mvagnon/zapdev/compare/v3.0.1...v3.0.2) (2026-10-07)


### Bug Fixes

* **git-task:** defer output until spinner completion ([5e26fae](https://github.com/mvagnon/zapdev/commit/5e26fae2180f882492620546c0512b31fb18ade6))

## [3.0.1](https://github.com/mvagnon/zapdev/compare/v3.0.0...v3.0.1) (2026-10-07)


### Bug Fixes

* **pipeline:** Enhance command execution with hooks and output logging ([dfac7dc](https://github.com/mvagnon/zapdev/commit/dfac7dcbb5e3e4fe0bb2c098b2a525f374205442))

## [3.0.0](https://github.com/mvagnon/zapdev/compare/v2.2.0...v3.0.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* add --ask-for-branch to prompt on every branch

### Features

* add --ask-for-branch to prompt on every branch ([71f9181](https://github.com/mvagnon/zapdev/commit/71f9181c35a63db5d77a95b85a66413642396b5e))

## [2.2.0](https://github.com/mvagnon/zapdev/compare/v2.1.1...v2.2.0) (2026-10-06)


### Features

* Implement context generation for commit tools ([9ee0681](https://github.com/mvagnon/zapdev/commit/9ee068125d448c5f2b2f9c20eb789a5f49244bc7))
* Improve commit message generation and validation ([44397d5](https://github.com/mvagnon/zapdev/commit/44397d563ac499ca870ee4553b47c8393180a98e))

## [2.1.1](https://github.com/mvagnon/zapdev/compare/v2.1.0...v2.1.1) (2026-10-06)


### Bug Fixes

* **docs:** add --no-push flag for local commits ([fd63f0e](https://github.com/mvagnon/zapdev/commit/fd63f0eb4580cb4bd43cc1c616a6d59dc0aa352f))

## [2.1.0](https://github.com/mvagnon/zapdev/compare/v2.0.0...v2.1.0) (2026-10-06)


### Features

* Enhance parallel push handling and testing utilities ([6c61c5c](https://github.com/mvagnon/zapdev/commit/6c61c5ca96febfcc062b255e7842108d42a39cf5))

## [2.0.0](https://github.com/mvagnon/zapdev/compare/v1.18.0...v2.0.0) (2026-10-06)


### Miscellaneous Chores

* release 2.0.0 ([38f4a51](https://github.com/mvagnon/zapdev/commit/38f4a517cf34b7147626abe0f4530ecaa7517e4b))

## [1.18.0](https://github.com/mvagnon/zapdev/compare/v1.17.0...v1.18.0) (2026-10-06)


### Features

* Improve error handling and flow control for parallel operations ([84578e2](https://github.com/mvagnon/zapdev/commit/84578e2d294a98a0b007184722c456ee0d5aadf0))

## [1.17.0](https://github.com/mvagnon/zapdev/compare/v1.16.0...v1.17.0) (2026-10-06)


### Features

* Improve parallel pull flow and logging in commit command ([3941842](https://github.com/mvagnon/zapdev/commit/394184214a4ec67a5cb3237a1329170b677b842f))

## [1.16.0](https://github.com/mvagnon/zapdev/compare/v1.15.0...v1.16.0) (2026-10-06)


### Features

* Refine readme on push behavior ([504d90b](https://github.com/mvagnon/zapdev/commit/504d90b8ac417542f610789cc256039ba0811ff1))

## [1.15.0](https://github.com/mvagnon/zapdev/compare/v1.14.0...v1.15.0) (2026-10-06)


### Features

* Enhance git task logging with better feedback during execution ([4ab2c10](https://github.com/mvagnon/zapdev/commit/4ab2c104e04651359a48cb8e24abb76e5a6ec5f4))

## [1.14.0](https://github.com/mvagnon/zapdev/compare/v1.13.0...v1.14.0) (2026-10-06)


### Features

* Improve documentation on pull and push behavior ([5d1dfa9](https://github.com/mvagnon/zapdev/commit/5d1dfa94dca856d8635a04a84f32978c27fa726e))

## [1.13.0](https://github.com/mvagnon/zapdev/compare/v1.12.0...v1.13.0) (2026-10-06)


### Features

* Enhance git integration regarding prompts and timeouts ([3e5800b](https://github.com/mvagnon/zapdev/commit/3e5800bf61f728eec40315cc9f640c65aec1b623))

## [1.12.0](https://github.com/mvagnon/zapdev/compare/v1.11.0...v1.12.0) (2026-10-06)


### Features

* remove subtree initialization command from CLI ([6d69bcf](https://github.com/mvagnon/zapdev/commit/6d69bcfcf232ad5a3a7e3f9f323bffebec301f86))
* **review:** track diff stats for parallelized commits ([e116106](https://github.com/mvagnon/zapdev/commit/e116106401087b32d649dc5a07d2e92e86c5a2be))
* update tests to remove reportNativeOutput from commit calls ([baaa711](https://github.com/mvagnon/zapdev/commit/baaa7118a5787b6c69759e9d4332729cd58fc3e3))

## [1.11.0](https://github.com/mvagnon/zapdev/compare/v1.10.0...v1.11.0) (2026-10-06)


### Features

* Update push behavior descriptions and improve clarity ([ca103d3](https://github.com/mvagnon/zapdev/commit/ca103d3b86e47c99cb25062ccad00629400ec792))

## [1.10.0](https://github.com/mvagnon/zapdev/compare/v1.9.0...v1.10.0) (2026-10-06)


### Features

* Update README and tests for commit options ([af2625e](https://github.com/mvagnon/zapdev/commit/af2625e8118f64ff48cf3f7c0677e9cfe2bf3d5c))

## [1.9.0](https://github.com/mvagnon/zapdev/compare/v1.8.0...v1.9.0) (2026-10-06)


### Features

* Improve push flow for shared commits ([d41a67e](https://github.com/mvagnon/zapdev/commit/d41a67e1ae96ec1fae722c415ea1ddfeeadd5a25))
* **subtree:** add subtree-init command support ([fbb6e3f](https://github.com/mvagnon/zapdev/commit/fbb6e3fc557afaa0d2580f12cfac8052e17642ca))

## [1.8.0](https://github.com/mvagnon/zapdev/compare/v1.7.0...v1.8.0) (2026-10-06)


### Features

* Improve commit command help text and tests ([6184202](https://github.com/mvagnon/zapdev/commit/61842024e3d27c0121f97113834e7a81c88481ce))

## [1.7.0](https://github.com/mvagnon/zapdev/compare/v1.6.0...v1.7.0) (2026-10-06)


### Features

* Add subtree publication support for zapdev ([cc17780](https://github.com/mvagnon/zapdev/commit/cc17780aba46e992f1fa2bdc66ded2d29cb60a06))

## [1.6.0](https://github.com/mvagnon/zapdev/compare/v1.5.0...v1.6.0) (2026-10-04)


### Features

* **tests:** improve error handling and logging in integration tests ([df66370](https://github.com/mvagnon/zapdev/commit/df663702404f8bd385afae3a79749fd66069388d))

## [1.5.0](https://github.com/mvagnon/zapdev/compare/v1.4.0...v1.5.0) (2026-10-04)


### Features

* **readme:** add timeout variable and improve llm section ([c9153d7](https://github.com/mvagnon/zapdev/commit/c9153d7d1e59d76d113141d3b6682ffb55d7e560))

## [1.4.0](https://github.com/mvagnon/zapdev/compare/v1.3.0...v1.4.0) (2026-10-04)


### Features

* Add bun install instruction to README ([ac130cf](https://github.com/mvagnon/zapdev/commit/ac130cf3750edb12336407e6d92e92d53d7cfd78))

## [1.3.0](https://github.com/mvagnon/zapdev/compare/v1.2.0...v1.3.0) (2026-09-27)


### Features

* **ui:** enhance unified review display with underline ([4e585c4](https://github.com/mvagnon/zapdev/commit/4e585c4cec7af8d7849fe9166a655ef96b323215))

## [1.2.0](https://github.com/mvagnon/zapdev/compare/v1.1.1...v1.2.0) (2026-09-27)


### Features

* **cli:** Enhance unified review with branch information and bolding ([1d91ac6](https://github.com/mvagnon/zapdev/commit/1d91ac633c0d2907faaf5d3ef3fcfd6e5157e110))

## [1.1.1](https://github.com/mvagnon/zapdev/compare/v1.1.0...v1.1.1) (2026-09-24)


### Bug Fixes

* **gitleaks:** add verbose output during scan ([816dc43](https://github.com/mvagnon/zapdev/commit/816dc4335aa89c44eea18dfc13d329aa6966a1d4))

## [1.1.0](https://github.com/mvagnon/zapdev/compare/v1.0.0...v1.1.0) (2026-09-24)


### Features

* Improve commit generation flow for multi-repo support ([4c019dc](https://github.com/mvagnon/zapdev/commit/4c019dc97e671df0a34b04cf2ab0789e56c99a63))

## [1.0.0](https://github.com/mvagnon/zapdev/compare/v0.11.0...v1.0.0) (2026-09-10)


### ⚠ BREAKING CHANGES

* require ZD_URL, ZD_MODEL and ZD_EFFORT instead of OLLAMA_* settings.

### Features

* replace Ollama integration with OpenAI-compatible endpoints ([ae97763](https://github.com/mvagnon/zapdev/commit/ae97763a02c953b841a6f54295116fd34c8f1dad))

## [0.11.0](https://github.com/mvagnon/zapdev/compare/v0.10.0...v0.11.0) (2026-08-08)


### Features

* **config:** add default value for OLLAMA_EFFORT ([88bd396](https://github.com/mvagnon/zapdev/commit/88bd39632d0bb91037c791275a8a50579a4b8b4c))

## [0.10.0](https://github.com/mvagnon/zapdev/compare/v0.9.0...v0.10.0) (2026-08-08)


### Features

* **config:** add backup model and thinking effort support ([cbbb643](https://github.com/mvagnon/zapdev/commit/cbbb643163f903bfe088c75d2d81f585b6b70d9b))
* **docs:** expand README and enhance commit command options ([7aa3520](https://github.com/mvagnon/zapdev/commit/7aa352086164a540227938980dec409736710fa9))

## [0.9.0](https://github.com/mvagnon/zapdev/compare/v0.8.0...v0.9.0) (2026-07-20)


### Features

* **commit:** auto-rebase on push rejection, remove --pull flag ([afe2d03](https://github.com/mvagnon/zapdev/commit/afe2d036d7fb2cdab5eb44f40f2c72f7d183a8ed))

## [0.8.0](https://github.com/mvagnon/zapdev/compare/v0.7.1...v0.8.0) (2026-07-19)


### Features

* **commit:** add --pull flag to rebase before push ([8639036](https://github.com/mvagnon/zapdev/commit/86390367d96582de0a23083400cdb156e82a3f5e))

## [0.7.1](https://github.com/mvagnon/zapdev/compare/v0.7.0...v0.7.1) (2026-07-19)


### Bug Fixes

* **reset:** support operating on a single repo or child repos ([0549bc3](https://github.com/mvagnon/zapdev/commit/0549bc342347e443115efbffacf55bc19d9c49e6))

## [0.7.0](https://github.com/mvagnon/zapdev/compare/v0.6.0...v0.7.0) (2026-07-19)


### Features

* **reset:** add reset command with worktree and branch cleanup ([db30007](https://github.com/mvagnon/zapdev/commit/db300075c80b67be44b7d766cab0a037ecfd05c4))

## [0.6.0](https://github.com/mvagnon/zapdev/compare/v0.5.0...v0.6.0) (2026-07-19)


### Features

* **ci:** migrate from Bun to Node.js/npm ([086b2dd](https://github.com/mvagnon/zapdev/commit/086b2dd981be030c7b2f239791fb5d7684244b3d))

## [0.5.0](https://github.com/mvagnon/zapdev/compare/v0.4.0...v0.5.0) (2026-07-02)


### Features

* **cli:** add --type flag for forced commit type ([6dc0259](https://github.com/mvagnon/zapdev/commit/6dc025933507964417e27240fadbc09cf0eabdcb))

## [0.4.0](https://github.com/mvagnon/zapdev/compare/v0.3.0...v0.4.0) (2026-07-01)


### Features

* **cli:** add interactive menu and cleanup command ([6068e07](https://github.com/mvagnon/zapdev/commit/6068e073698e28203e39848c23956c656977f813))

## [0.3.0](https://github.com/mvagnon/zapdev/compare/v0.2.0...v0.3.0) (2026-07-01)


### Features

* add qgit commit command with LLM-generated messages ([9ceb0f0](https://github.com/mvagnon/zapdev/commit/9ceb0f0e495f00793f1d80c6678ec980d0ef182e))
* add qgit commit command with LLM-generated messages ([bfc0531](https://github.com/mvagnon/zapdev/commit/bfc0531c3a5b42102e69d82d4dc7dca83e9fe1cb))

## [0.2.0](https://github.com/mvagnon/zapdev/compare/v0.1.0...v0.2.0) (2026-07-01)


### Features

* add qgit commit command with LLM-generated messages ([9ceb0f0](https://github.com/mvagnon/zapdev/commit/9ceb0f0e495f00793f1d80c6678ec980d0ef182e))
* add qgit commit command with LLM-generated messages ([bfc0531](https://github.com/mvagnon/zapdev/commit/bfc0531c3a5b42102e69d82d4dc7dca83e9fe1cb))
