#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static int open_beneath(int root, const char *name) {
  const struct open_how how = {
    .flags = O_PATH | O_CLOEXEC,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV,
  };
  return (int)syscall(SYS_openat2, root, name, &how, sizeof(how));
}

static int read_source(int root, const char *name, char *buffer, size_t size) {
  int entry = open_beneath(root, name);
  if (entry < 0)
    return -1;

  struct stat info;
  assert(fstat(entry, &info) == 0);
  if (!S_ISREG(info.st_mode) || info.st_nlink != 1) {
    assert(close(entry) == 0);
    errno = EPERM;
    return -1;
  }

  char descriptor[64];
  assert(snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", entry) > 0);
  int file = open(descriptor, O_RDONLY | O_CLOEXEC);
  assert(file >= 0);
  assert(close(entry) == 0);
  int bytes = (int)read(file, buffer, size);
  assert(close(file) == 0);
  return bytes;
}

static void expect_source(int root, const char *name, const char *expected) {
  char buffer[64];
  assert(read_source(root, name, buffer, sizeof(buffer)) == (int)strlen(expected));
  assert(memcmp(buffer, expected, strlen(expected)) == 0);
}

static void expect_refusal(int root, const char *name, int error) {
  char buffer[64];
  assert(read_source(root, name, buffer, sizeof(buffer)) == -1);
  assert(errno == error);
}

static void swap_directory(int root) {
  assert(renameat2(root, "src", root, "swap", RENAME_EXCHANGE) == 0);
}

int main(void) {
  int first = open("first", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int second = open("second", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  assert(first >= 0 && second >= 0);
  expect_source(first, "src/sample.txt", "first workspace\n");
  expect_source(second, "src/sample.txt", "second workspace\n");
  expect_refusal(first, "../second/src/sample.txt", EXDEV);
  expect_refusal(first, "/second/src/sample.txt", EXDEV);
  expect_refusal(first, "linked.txt", ELOOP);
  expect_refusal(first, "linked-copy.txt", EPERM);
  expect_refusal(first, "src", EPERM);
  expect_refusal(first, "pipe", EPERM);

  swap_directory(first);
  expect_refusal(first, "src/sample.txt", ELOOP);
  swap_directory(first);

  pid_t mover = fork();
  assert(mover >= 0);
  if (mover == 0) {
    for (int i = 0; i < 4000; i++)
      swap_directory(first);
    _exit(0);
  }

  for (int i = 0; i < 4000; i++) {
    char buffer[64];
    int bytes = read_source(first, "src/sample.txt", buffer, sizeof(buffer));
    if (bytes < 0) {
      assert(errno == ELOOP || errno == EAGAIN);
    } else {
      assert(bytes == (int)strlen("first workspace\n"));
      assert(memcmp(buffer, "first workspace\n", (size_t)bytes) == 0);
    }
  }

  int status;
  assert(waitpid(mover, &status, 0) == mover);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
  expect_source(first, "src/sample.txt", "first workspace\n");

  assert(renameat2(AT_FDCWD, "first", AT_FDCWD, "second", RENAME_EXCHANGE) == 0);
  expect_source(first, "src/sample.txt", "first workspace\n");
  expect_source(second, "src/sample.txt", "second workspace\n");
  assert(close(first) == 0);
  assert(close(second) == 0);
  puts("Workspace fixture passed on Linux");
}
