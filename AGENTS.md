# Project instructions

## Code style

When editing existing code, read the surrounding implementation first and match its style, naming, structure, and level of commentary. Changes should look like they were written by the same person as the rest of the project.

## Git authorization

- Never commit or push changes unless the user specifically asks to commit or push. A request to edit, fix, build, test, deploy, or publish does not by itself grant permission to commit or push.
- If an otherwise requested workflow requires a commit or push, stop and ask for that permission first.

## Source of truth and deployment

- This repository is the source of truth for the website. Never make a hosted code change without making the corresponding change in the project files first.
- When the user specifically authorizes committing and pushing a website source change, validate the current project, commit it, push that exact commit to the project remote and the Sites source branch, then save and deploy a Sites version from that same commit SHA.
- Before reporting a deployment complete, verify that the newest deployed Sites version references the same commit as the latest pushed deployment-branch commit. Do not deploy an older commit over a newer pushed one.
- Keep the working tree free of uncommitted website changes when publishing. If the user requests a branch, pull request, or local-only change, follow that request instead of publishing directly.
- Runtime secrets belong in Sites environment settings and ignored local environment files, never in Git. An environment-only update may redeploy the latest saved source version rather than creating an empty source commit.
- Preserve the existing D1 and R2 bindings and their data across ordinary deployments. Change, replace, reset, or migrate persistent storage only when the user explicitly requests it and a recoverable backup exists.
