# das-github-mirror Contributor Guide

## Getting Started

Before contributing, please:

1. Read the [README](./README.md) to understand the project
2. Familiarize yourself with the project structure and tech stack
3. Check existing issues and PRs to avoid duplicate work

## Local Development

1. Ensure you have the required runtime installed (check README for version requirements)
2. Clone the repo and install dependencies
3. Copy `.env.example` to `.env` and configure as needed
4. Follow the README to start the development server

## Creating Issues

When opening an issue, use the appropriate template:

- **[Bug Report](.github/ISSUE_TEMPLATE/bug_report.md)** - Report bugs or unexpected behavior. Include steps to reproduce, expected vs actual behavior, and environment details.
- **[Feature Request](.github/ISSUE_TEMPLATE/feature_request.md)** - Suggest new features or improvements. Explain the motivation and proposed solution.
- **Blank Issue** - For issues that don't fit the above templates.

For security vulnerabilities, **do not create a public issue**. Report them privately via [GitHub Security Advisories](https://github.com/entrius/das-github-mirror/security/advisories/new).

## Pull Request Process

### 1. Create Your Branch

- Branch off of `test` and target it with your PR. PRs that target the wrong base branch will be closed without review.
- Ensure there are no conflicts before submitting

### 2. Make Your Changes

- Write clean, well-documented code
- Follow existing code patterns and architecture
- Update documentation if applicable
- Ensure everything builds and runs correctly before submitting

### 3. Submit Pull Request

1. Push your branch to the repository
2. Open a PR targeting `test`
3. Fill out the [PR template](.github/PULL_REQUEST_TEMPLATE.md):
    - **Summary**: Clear description of changes
    - **Related Issues**: Link issues using `Fixes #123` or `Closes #456`
    - **Type of Change**: Select bug fix, new feature, refactor, documentation, or other
    - **Testing**: Confirm manual testing performed
    - **Checklist**: Verify your changes meet the repo's standards

### 4. Code Review

- Reviewers will be assigned automatically
- Address review comments promptly

### Issue Scope

PRs should focus on the linked issue. Minor incidental changes are fine. PRs dominated by unrelated changes (>50% of the diff) will be asked to scope down.

### PR Iteration Expectations

The repository runs an automated maintainer agent that may close PRs in the following cases:

- Failing CI for 12+ hours with no fix pushed
- Unresolved merge conflicts for 12+ hours with no resolution push
- Requested changes from a maintainer for 12+ hours with no follow-up commits

## Automatic Closures

The maintainer bot enforces these rules without manual review. Contributions that violate them are closed automatically.

### Open item limits

Each contributor may have at most **2 open PRs** and **2 open issues** in this repository at any time. Submitting a 3rd of either type while at the cap closes the new one on submission. The limits apply independently — you can have 2 open PRs and 2 open issues at the same time.

## PR Labels

Apply appropriate labels to help categorize and track your contribution:

- `bug` - Bug fixes
- `feature` - New feature additions
- `enhancement` - Improvements to existing features
- `refactor` - Code refactoring without functionality changes
- `documentation` - Documentation updates

## Code Standards

### Quality Expectations

- Follow repository conventions (commenting style, variable naming, etc.)
- Use sensible component decomposition to keep files manageable
- Write clean, readable, maintainable code
- Avoid modifying unrelated files
- Avoid adding unnecessary dependencies
- Ensure all build checks pass before submitting

## Branches

### `test`

**Purpose**: Main development and production-ready code

**Restrictions**:

- Requires pull request
- Requires all checks to pass
- Requires at least one approval

## License

By contributing to das-github-mirror, you agree that your contributions will be licensed under the project's MIT license.

---

Thank you for contributing to das-github-mirror!
