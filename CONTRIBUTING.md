# Contributing to Jiraffe

Thanks for your interest in contributing. This guide describes how to propose
changes. Please also read the [Code of Conduct](CODE_OF_CONDUCT.md).

The repository has code, tests and tooling (lint, formatting, build, typecheck;
see the [README](README.md) for the commands). Where this guide mentions checks
or tests, it means those that exist in the repository at the time of your change.

## Reporting bugs and proposing features

- **Bug:** open an issue with the
  [Bug report](https://github.com/luk98j/Jiraffe/issues/new?template=bug_report.yml)
  form.
- **Feature or idea:** open an issue with the
  [Feature request](https://github.com/luk98j/Jiraffe/issues/new?template=feature_request.yml)
  form. For larger changes, discuss the idea in an issue before writing code.
- **Security vulnerability:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

Search existing issues first to avoid duplicates.

## Workflow

1. Fork the repository on GitHub and clone your fork.
2. Create a branch from `main` (see naming below).
3. Make your change and commit it.
4. Push the branch to your fork.
5. Open a pull request against `main` and fill in the pull request template.

### Branch naming

Use `<type>/<short-slug>`, where `type` is one of the commit types below and
the slug is a few lowercase words separated by hyphens.

Examples: `feat/add-issue-search`, `fix/null-title`, `docs/contributing-guide`.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short summary in the imperative mood>
```

Types:

| Type       | Use for                                          |
|------------|--------------------------------------------------|
| `feat`     | a new feature                                    |
| `fix`      | a bug fix                                        |
| `docs`     | documentation only                               |
| `chore`    | maintenance that changes no behavior or docs     |
| `refactor` | code change that neither fixes a bug nor adds a feature |
| `test`     | adding or changing tests                         |

An optional scope may follow the type, for example `fix(parser): ...`. The
pull request title should follow the same format.

## Pull requests

- Keep pull requests small and focused on one change. Split unrelated changes
  into separate pull requests.
- Link the issue the pull request addresses, if there is one.
- Update documentation when your change affects it.
- Run the tests and checks the project has, if any, and make sure they pass
  before requesting review. Do not add new tooling as a side effect of an
  unrelated change; propose it in an issue first.

## Review

- The maintainer reviews pull requests as time allows; please be patient.
- Expect questions and requests for changes. Respond in the pull request
  thread and push follow-up commits to the same branch.
- A pull request is merged once the maintainer approves it and any checks
  that exist pass.
- Reviews are about the change, not the person. Keep to the
  [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
terms of the [LICENSE](LICENSE) (MIT).
