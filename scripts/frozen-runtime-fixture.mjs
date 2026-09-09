// Test-only fixture loader. Never mutates a frozen package or changes its manifest.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
export const v8ConnectionBaseline = "efa918be3478f88ff0120dad8727a9bb366c3d25";
export const v9TextBaseline = "06551bb9255aefd92e945df158f4db47066606da";
export const v10CharterBaseline = "b538ee8792abee6dfefc152fd9c90e73ba4d4bc5";
export const v11ReplyBaseline = "b49880ae6e5376f03b4ff79f6270b3e6576c55d8";
export const v12HelpBaseline = "cf377f3ad4aba4dd1a31ccbd7691b3a7393c8f16";
export const v13OfferBaseline = "61f12941e0b195487a3718451725e78cf444675b";
export const v14InboxBaseline = "a96887c30b124077bfa675c4bec584c224d3b66c";
export const v15AdoptionBaseline = "6081c46a0536d215dc0fafe2a253997f88b8dd22";
export const v16SendBaseline = "acac701e5dceba5293ac729a5d761ae252cfb4dc";
export const v17EmailBaseline = "ea71f70b004503e7a07bb7cac29ed4cf08bda543";
export const v18EmailSourceBaseline = "86c26747ce8b02ec2b5e78b0f0c3dd77e761c994";
export const v19EmailExcerptBaseline = "9b81c2cafac1901013a251ff058a286c8f78b7cc";
export const v20ReplyJournalBaseline = "a17f005f613c5be6996fe84bfa9317cbe7e47834";
export const v21ReplyReviewBaseline = "3bfa4231aa7d254cf5fe509368d5a19010379b9e";
export const v22ReplyUpdateBaseline = "05adfd3c59ce33db9fda73368dc81622aa54f032";
export const v23ReplyAcknowledgmentBaseline = "0713606fe68bd639b8176998113c54865953b56d";
export const v24ReplyResolutionBaseline = "07a13aaaa5b820f579586615b93312a084ce4061";
async function frozenFixture(repository, packagePath, commit, file, name) {
  const source = execFileSync("git", ["show", `${commit}:scripts/${file}.mjs`], { cwd: repository, encoding: "utf8" })
    .replace(/from "\.\.\/([^"]+)"/g, (_, path) => `from ${JSON.stringify(pathToFileURL(join(packagePath, path)).href)}`);
  return (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64")))[name];
}
export const frozenRecoveryFixture = (repository, packagePath, commit = v8ConnectionBaseline) => frozenFixture(repository, packagePath, commit, "recovery-fixture", "createRecoveryFixture");
export const frozenAcceptanceFixture = (repository, packagePath, commit = v12HelpBaseline) => frozenFixture(repository, packagePath, commit, "acceptance-fixture", "createAcceptanceFixture");
