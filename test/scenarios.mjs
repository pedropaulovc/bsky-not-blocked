/*
 * The threads the end-to-end runs open, shared by the Chrome and Firefox
 * harnesses so both browsers are held to the same bar.
 *
 * These are real, live threads. If a post is deleted or a block is lifted, the
 * scenario stops being a test of anything — a failure here means "check the
 * fixture", not necessarily "the extension broke".
 */
export const SCENARIOS = [
  {
    name: 'blocked quote embed',
    url: 'https://bsky.app/profile/ed3d.net/post/3mt5jmqs4n22n',
    // ed3d.net quotes skity.bsky.social; the two accounts block each other, so
    // the quote is a grey placeholder for every third-party viewer.
    expect: ['@skity.bsky.social', 'Coding is largely solved'],
    absent: 'Blocked',
  },
  {
    name: 'blocked parent in a thread',
    url: 'https://bsky.app/profile/skity.bsky.social/post/3mt5n422h422o',
    // The parent is by aly.codes, whom skity blocks, so it is dropped for
    // everyone. It also carries a blocked quote of its own, which exercises the
    // second pass of the resolve loop.
    expect: ['@aly.codes', 'extremely normal analogy'],
    // A dropped parent renders as a "Post blocked" banner above the anchor,
    // worded differently from the "Blocked" card a hidden quote leaves behind.
    absent: 'Post blocked',
  },
];
