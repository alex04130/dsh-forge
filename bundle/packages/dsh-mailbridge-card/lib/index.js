// Host half: this package contributes only a browser half, but the profile mounts
// it as a dual-face package (same shape as @local/dsh-plugmgr / @local/dsh-dynrestore),
// so it still needs a host entry point.
export default {
  name: 'mailbridge-card',
  apply() {},
}
