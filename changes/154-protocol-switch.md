- `TOOLSCRIPT_PROTOCOL=legacy|auto` (environment only, no config key, so a config stays readable by 1.0.5) chooses the protocol of
  toolscript-mcp, and `TOOLSCRIPT_LEGACY_SERVERS=<key>,<key>` keeps named servers on `legacy` under `auto`. In this release `auto`
  only separates shared children: a `legacy` link and an `auto` link never share one, and with neither variable set nothing
  changes. A bad `TOOLSCRIPT_PROTOCOL` is a config error that never repeats the value; an unknown item of the list gives one
  stderr line and never stops a start. `doctor` names the protocol when a variable changes it.
