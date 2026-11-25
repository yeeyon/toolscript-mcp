#!/usr/bin/perl
# The POSIX task helper (issue #149): /usr/bin/perl task-reap.pl <prctl number> <file> <arg>...
# No module is loaded on the path of a task: strict, warnings and Config cost 5 to 6 ms of the start (measured).
#
# fd 3 is a duplex socket to the host. In: one frame (4-byte big-endian length, then NAME=VALUE entries with NUL between
# them), the whole environment of the task. After the frame, the end of the socket (the host stopped, or died) or any
# byte is the order to stop. The helper also takes SIGTERM, SIGINT and SIGHUP as a stop.
# Out: one report on each line: begin, started:<pid> or error:<errno>, then exit:<code>, signal:<number> or stopped,
# and left:<count> when processes stayed. failed:<step> comes before begin only: the task was not started.
# The helper writes nothing to the streams of the task.
#
# Linux: the helper is the child subreaper, so each orphan of the task becomes its child and no descendant can leave.
# macOS: no such thing. The tree is the process group of the task, the live ppid chain, and each process whose
# environment holds the marker TOOLSCRIPT_TASK.

my $linux = $^O eq 'linux';
open(my $ctl, '+<&=', 3) or exit 70;
$SIG{PIPE} = 'IGNORE';
sub report { syswrite($ctl, "$_[0]\n") }
sub failed { report("failed:$_[0]"); exit 0 }

# The helper never writes to the streams of the task: its own stderr goes nowhere, and the task gets the real one back.
open(my $stderr, '>&', \*STDERR) or failed('streams');
open(STDERR, '>', '/dev/null') or failed('streams');

my ($nr, $file, @args) = @ARGV;
defined $file or failed('usage');

sub need {
  my ($want, $got) = ($_[0], '');
  while (length($got) < $want) {
    sysread($ctl, $got, $want - length($got), length($got)) or failed('frame');
  }
  return $got;
}
my $size = unpack('N', need(4));
$size <= 4 * 1024 * 1024 or failed('frame');
%ENV = ();
for my $entry (split /\0/, $size ? need($size) : '') {
  my ($name, $value) = split /=/, $entry, 2;
  $ENV{$name} = $value;
}

if ($linux) {
  # prctl has no perl name without the kernel headers. The host sends its number: 157 on x86_64, 167 on aarch64.
  $nr =~ /^(157|167)$/ or failed('arch');
  # 36 is PR_SET_CHILD_SUBREAPER, 37 reads it back into an int.
  syscall($nr, 36, 1, 0, 0, 0) == 0 or failed('subreaper');
  my $got = "\0" x 8;
  (syscall($nr, 37, $got, 0, 0, 0) == 0 && unpack('i', $got) == 1) or failed('subreaper');
}
my $mark = $ENV{TOOLSCRIPT_TASK};
!$linux && !defined $mark and failed('marker');

pipe(my $sr, my $sw) or failed('pipe');
pipe(my $er, my $ew) or failed('pipe');
$SIG{CHLD} = sub { syswrite($sw, 'c') };
$SIG{TERM} = $SIG{INT} = $SIG{HUP} = sub { syswrite($sw, 't') };

report('begin');
my $pid = fork();
if (!defined $pid) { report('error:' . ($! + 0)); exit 0 }
if ($pid == 0) {
  # The task leads its own process group, as with a direct spawn: a signal to its group never reaches the helper.
  setpgrp(0, 0);
  $SIG{$_} = 'DEFAULT' for qw(CHLD TERM INT HUP PIPE);
  close $ctl; close $er; close $sr; close $sw;
  open(STDERR, '>&', $stderr);
  exec { $file } $file, @args;
  syswrite($ew, $! + 0);
  require POSIX;
  POSIX::_exit(127);
}
close $ew;
my $errno = '';
sysread($er, $errno, 16);
close $er;
if ($errno ne '') { waitpid($pid, 0); report("error:$errno"); exit 0 }
report("started:$pid");

my ($status, $stop);
until (defined $status || $stop) {
  my $rin = '';
  vec($rin, fileno($ctl), 1) = 1;
  vec($rin, fileno($sr), 1) = 1;
  my $n = select(my $rout = $rin, undef, undef, undef);
  next if $n < 0;
  if (vec($rout, fileno($sr), 1)) {
    sysread($sr, my $woke, 4096);
    $stop = 1 if $woke =~ /t/;
    while ((my $p = waitpid(-1, 1)) > 0) { $status = $? if $p == $pid }
  }
  $stop = 1 if vec($rout, fileno($ctl), 1);
}

# The pids of the tree that still run, without this process.
sub tree {
  my (%kids, %state, @out);
  if ($linux) {
    opendir(my $d, '/proc') or return;
    for my $p (grep { /^\d+$/ } readdir $d) {
      open(my $f, '<', "/proc/$p/stat") or next;
      my $line = <$f>;
      close $f;
      defined $line && $line =~ /^\d+ \(.*\) (\S) (\d+) /s or next;
      $state{$p} = $1;
      push @{ $kids{$2} }, $p;
    }
    my @todo = @{ $kids{$$} || [] };
    while (defined(my $p = shift @todo)) {
      push @out, $p if $state{$p} ne 'Z';
      push @todo, @{ $kids{$p} || [] };
    }
    return @out;
  }
  my $ps = open(my $f, '-|', '/bin/ps', '-axEww', '-o', 'pid=,ppid=,pgid=,command=') or return;
  my (%hit, %all);
  while (my $line = <$f>) {
    $line =~ /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/s or next;
    next if $1 == $$ || $1 == $ps;
    $all{$1} = 1;
    push @{ $kids{$2} }, $1;
    $hit{$1} = 1 if $3 == $pid || index($4, " TOOLSCRIPT_TASK=$mark") >= 0;
  }
  close $f;
  my @todo = @{ $kids{$$} || [] };
  while (defined(my $p = shift @todo)) { $hit{$p} = 1; push @todo, @{ $kids{$p} || [] } }
  return grep { $all{$_} } keys %hit;
}

my $left = 0;
for my $round (1 .. 400) {
  my $w;
  while (($w = waitpid(-1, 1)) > 0) { $status = $? if $w == $pid && !$stop }
  # Linux: each process that is left is a child of this one, or under one. No child means that nothing is left.
  if ($linux && $w < 0) { $left = 0; last }
  my @pids = tree();
  $left = @pids;
  last if !$left;
  kill 'KILL', @pids;
  select(undef, undef, undef, 0.005);
}
report(!defined $status ? 'stopped' : $status & 127 ? 'signal:' . ($status & 127) : 'exit:' . ($status >> 8));
report("left:$left") if $left;
exit 0;
