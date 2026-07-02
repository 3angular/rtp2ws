# Third-Party Notices

This repository's original source code is licensed under Apache-2.0. Third-party
software used by the build, runtime images, and release artifacts remains under
its own license terms.

## Asterisk

The `asterisk/` Docker build downloads and builds Asterisk. Asterisk is
distributed under GPLv2 by Sangoma US Inc. Binary or container distributions that
include Asterisk must satisfy the applicable GPLv2 obligations, including license
text, notices, and corresponding source availability for the exact Asterisk source
and patches used.

Upstream license reference:
https://raw.githubusercontent.com/asterisk/asterisk/master/LICENSE

## asterisk-amr

The `asterisk/` Docker build applies sources and patches from `traud/asterisk-amr`
at the commit pinned in `asterisk/Dockerfile`. GitHub identifies that project as
Unlicense. Keep the pinned commit and provenance visible in binary distribution
materials.

Project reference:
https://github.com/traud/asterisk-amr

AMR codec/transcoding support may involve additional patent or codec licensing
considerations depending on jurisdiction and deployment model. Review this before
commercial telecom distribution.

## Debian and Node Images

The Dockerfiles use Debian and Node base images and install Debian packages.
Redistributed container images include those packages under their respective
licenses. Preserve required package notices and source-offer obligations when
publishing images.

## npm Dependencies

The sidecar depends on npm packages whose visible package metadata is permissive
overall, including MIT, Apache-2.0, BSD, ISC, and Unlicense licenses. Regenerate
dependency notices from `sidecar/package-lock.json` when preparing a binary
release or published container image.
