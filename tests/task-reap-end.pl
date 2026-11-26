# A fake POSIX helper for the lost-helper test (issue #149): it reads the frame first, as task-reap.pl does, reports
# `begin` and ends with no end report. The task never runs, and the call must give an error and no second start.
open(my $ctl, '+<&=', 3) or exit 70;
sub need {
  my ($want, $got) = ($_[0], '');
  while (length($got) < $want) {
    sysread($ctl, $got, $want - length($got), length($got)) or exit 71;
  }
  return $got;
}
need(unpack('N', need(4)));
syswrite($ctl, "begin\n");
exit 0;
