/*
 * Slow-disk shim for the Galata Empty Trash performance test.
 *
 * The test widens the removal into a window long enough to measure by
 * delaying each removal syscall. Only removals under TRASH_SLOW_PREFIX are
 * delayed by path; the fd-based shutil.rmtree hot path deletes with a
 * relative name, which cannot be matched against the prefix, so relative
 * unlinkat calls are delayed too. The shim is preloaded into the test
 * server only - never into the test runner or the browser - and the prefix
 * is under ui-tests/.trash-home, so no other file is slowed.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void slow_wait(void) {
  const char *us = getenv("TRASH_SLOW_US");
  long usec = us ? atol(us) : 0;
  if (usec <= 0) {
    return;
  }
  struct timespec ts = {usec / 1000000, (usec % 1000000) * 1000};
  nanosleep(&ts, NULL);
}

static int under_prefix(const char *path) {
  const char *prefix = getenv("TRASH_SLOW_PREFIX");
  if (!prefix || !path) {
    return 0;
  }
  return strncmp(path, prefix, strlen(prefix)) == 0;
}

int unlink(const char *path) {
  static int (*real)(const char *);
  if (!real) {
    real = (int (*)(const char *))(void *)dlsym(RTLD_NEXT, "unlink");
  }
  if (under_prefix(path)) {
    slow_wait();
  }
  return real(path);
}

int rmdir(const char *path) {
  static int (*real)(const char *);
  if (!real) {
    real = (int (*)(const char *))(void *)dlsym(RTLD_NEXT, "rmdir");
  }
  if (under_prefix(path)) {
    slow_wait();
  }
  return real(path);
}

int unlinkat(int dirfd, const char *path, int flags) {
  static int (*real)(int, const char *, int);
  if (!real) {
    real = (int (*)(int, const char *, int))(void *)
        dlsym(RTLD_NEXT, "unlinkat");
  }
  // A relative name belongs to an open trash directory: delay it.
  if (!path || path[0] != '/' || under_prefix(path)) {
    slow_wait();
  }
  return real(dirfd, path, flags);
}
