# A fake POSIX helper for the fallback test (issue #149): it reports `failed:job` and ends. It never starts the task.
# It reads the frame first, as task-reap.pl does: a helper that ends before the host's write makes that write fail, and
# the host can lose the report.
open(my $ctl, '+<&=', 3) or exit 70;
sub need {
  my ($want, $got) = ($_[0], '');
  while (length($got) < $want) {
    sysread($ctl, $got, $want - length($got), length($got)) or exit 71;
  }
  return $got;
}
need(unpack('N', need(4)));
syswrite($ctl, "failed:job\n");
exit 0;
