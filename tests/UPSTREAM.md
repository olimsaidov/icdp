# Upstream test provenance

ICDP's Chromium-derived TypeScript tests and accessibility goldens are pinned
to these source revisions:

- Chromium: `3093417a828d9cea09f10201d61a72ccd25cf498`
- V8: `bc94799c8f9a86bd4b5c5bc141c3df68aeaed452`

Comments beside each adapted test identify its upstream file or implementation
seam. The tests run entirely against ICDP and have no Chromium runtime
dependency.

`npm run gen:conformance` reads accessibility goldens from the pinned Chromium
commit with `git show`, so a newer local checkout cannot silently change the
vendored expectations.
