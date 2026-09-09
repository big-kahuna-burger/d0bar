# Publishing packages

Packages are published from GitHub Actions through the **Publish packages** workflow. Enter a
SemVer version such as `0.1.0` or `0.1.0-preview.0`, then select **prerelease** when applicable.
The workflow builds and verifies the workspace, updates all package manifests in one release
commit, creates a `v…` tag, and publishes:

- `d0bar`
- `@d0bar/signals`
- `@d0bar/frame-budget`

Stable releases use npm's `latest` tag. Prereleases use `next`, so consumers opt in explicitly:

```sh
npm install d0bar@next
```

The workflow uses npm trusted publishing and provenance. Before the first run, configure each
package in npm as a trusted publisher for this GitHub repository and the `publish-release.yml`
workflow. The GitHub environment named `npm-release` is the approval boundary; protect it with
the reviewers appropriate for publishing packages.

The release workflow publishes all packages before it commits the version bump, pushes the tag to
`main`, and creates a GitHub release. A failed npm publish therefore cannot create a tag or a
release that names packages npm did not accept. Do not start it concurrently with another release.
