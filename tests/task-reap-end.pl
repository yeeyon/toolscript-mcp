# A fake POSIX helper for the lost-helper test (issue #149): it reports `begin` and ends with no end report. The task
# never runs, and the call must give an error and no second start.
open(my $ctl, '+<&=', 3) or exit 70;
syswrite($ctl, "begin\n");
exit 0;
