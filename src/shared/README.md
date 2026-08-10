# shared

Shared contains infrastructure and utilities that are reusable across independent feature modules.

Allowed here:

- Stable config constants.
- Generic i18n copy.
- Generic formatting and string utilities.

Not allowed here:

- Payment rules.
- Order workflow rules.
- Customer menu-only behavior.
- Admin product form behavior.
- Station workflow behavior.

If a helper is used by only one feature, keep it in that feature.

