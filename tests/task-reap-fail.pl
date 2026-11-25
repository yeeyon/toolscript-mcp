# A fake POSIX helper for the fallback test (issue #149): it reports `failed:job` and ends. It never starts the task.
open(my $ctl, '+<&=', 3) or exit 70;
syswrite($ctl, "failed:job\n");
exit 0;
