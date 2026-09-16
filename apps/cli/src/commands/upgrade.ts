/**
 * `perch upgrade`: replace this binary with the newest release (task 4.3).
 *
 * The point of a self-hosted thing you download is that upgrading it is one command and not a
 * paragraph of instructions. Nothing is installed that does not match the checksum the release
 * published — and when cosign is on the machine, the signature over those checksums is checked
 * too. The binary being replaced is kept until the new one is in place.
 */
import { parseArgs } from "node:util";
import { currentVersion, latestRelease, sameVersion, UpgradeError, upgrade } from "../upgrade.ts";

const USAGE = `perch upgrade [options]

Replaces this binary with the newest Perch release, after checking it against the
SHA256SUMS that release published and, where cosign is installed, the signature over
them.

Options:
  --check                say what the newest release is and stop
  --force                install it even when it is the version already here
  --require-signature    refuse to install unless cosign verifies the release's signature
  --releases <url>       the releases API to ask (default: Perch's own)
  --help                 show this help`;

export async function runUpgrade(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean" },
      force: { type: "boolean" },
      "require-signature": { type: "boolean" },
      releases: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const here = currentVersion();
  try {
    if (values.check) {
      const release = await latestRelease({
        ...(values.releases ? { releases: values.releases } : {}),
      });
      console.log(
        sameVersion(release.tag, here)
          ? `perch ${here} is the newest release`
          : `perch ${here} → ${release.tag} (run \`perch upgrade\`)`,
      );
      return 0;
    }
    const result = await upgrade({
      ...(values.force ? { force: true } : {}),
      ...(values["require-signature"] ? { requireSignature: true } : {}),
      ...(values.releases ? { releases: values.releases } : {}),
      log: (line) => console.log(line),
    });
    if (result.already) console.log(`perch ${result.from} is already the newest release`);
    return 0;
  } catch (error) {
    console.error(error instanceof UpgradeError ? error.message : String(error));
    return 1;
  }
}
