# DeeDou Preview Deployment

Purpose: provide a safe browser-accessible preview of the verified `main` branch for product testing.

## Source of truth

- Repository: `hcinfitong-create/deedou-pos`
- Branch: `main`
- Preview must be deployed only from a clean, synchronized local checkout of `main`.

## Deployment rules

- Preview is for functional testing only; it is not production.
- Do not add backend, auth, payment integrations, or database changes as part of preview deployment.
- Do not expose secrets or `.env` files.
- Preserve the existing hash routes and static/local-first behavior.
- Prefer a Vercel Preview deployment, not Production.

## Validation before deployment

Run:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
npm run check
npm test
git status -sb
```

The working tree must be clean and local `main` must match `origin/main`.

## Expected preview routes

- Customer: `/#/t/beach-a01-47VLmz`
- Cashier: `/#/cashier`
- Staff: `/#/staff`
- Bar: `/#/bar`
- Kitchen: `/#/kitchen`
- Dessert: `/#/dessert`
- Admin: `/#/admin`

## Completion evidence

Report:

- deployed commit SHA
- preview URL
- deployment target (`preview`)
- `npm run check` result
- `npm test` result
- confirmation that no production deployment was made
