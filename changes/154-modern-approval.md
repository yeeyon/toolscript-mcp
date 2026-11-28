- On a 2026-07-28 connection (`TOOLSCRIPT_PROTOCOL=auto`), an `ask` rule now asks the person: `run_code` answers with a request for input,
  the client shows the same prompt as before, and the program runs only after an accept. The answer belongs to that program, those
  tools and that policy, works one time and for 10 minutes, and a restart ends it. A client that did not declare elicitation in the
  request still gets the refusal for a client that cannot ask. The prompt of a looser policy is a round of its own. The prompts and the
  refusal texts are the same as on the older protocol, and the older protocol is unchanged.
