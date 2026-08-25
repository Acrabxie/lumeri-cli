# Security Policy

## Supported releases

Security fixes target the current `1.x` releases of `lumeri-video` and
`lumeri-quanta`. The combined `lumeri-cli@1.0.0` package is a frozen
compatibility artifact and is not a supported security-update channel; migrate
to the corresponding split package for current fixes.

The archived legacy branch is unsupported and must not be used as a release
source.

## Report a vulnerability

Use GitHub's private **Report a vulnerability** flow when it is available. If
that option is not shown, contact the repository owner through the public
contact channel on their [GitHub profile](https://github.com/Acrabxie) and
request a private reporting path;
do not include vulnerability details in that first message or in a public
issue.

Include the affected package and version, the observable impact, and the
smallest safe reproduction you can provide. Never include access tokens, API
keys, account data, private media, or other credentials in a report or test
fixture. Revoke any credential that may already have been disclosed.

## Public package boundary

The public npm packages are clients for an already installed Lumeri Runtime.
They do not own account sign-in or switching, model-provider configuration,
subscription credential import, API-key storage, Runtime installation, or
local media processing. The interactive CLI can forward explicit sandbox and
background-task control requests, but the Runtime owns and authorizes those
operations.

Reports about the CLI transport, terminal rendering, local file validation,
package contents, or package-install behavior belong here. Reports about the
installed Lumeri product or Runtime should be submitted through that product's
private support channel instead of attaching private service details to this
public repository.
