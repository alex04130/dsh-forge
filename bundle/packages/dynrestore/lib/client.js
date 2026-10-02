// Auto-restore dynamic client packages on page boot and reconnect.
window.__ModuleLoader__.load({
  id: '@local/dsh-dynrestore',
  factory: function () {
    return {
      inject: ['remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner'],
      apply: function (ctx) {
        var gate = Promise.resolve()
        var restoredKeys = {} // pluginId:packageId -> true; suppress repeated startUserRun noise
        var attempts = 0 // follow-up poll rounds; whole-success resets to 0 (no 6-round burst)
        var failing = false // a package still pending in the last pass
        function restore() {
          gate = gate.then(async function () {
            try {
              failing = false
              var result = await ctx.remote.dynamicCordisRunner.inventory()
              var rows = Array.isArray(result) ? result
                : (result !== null && typeof result === 'object' && Array.isArray(result.rows) ? result.rows
                  : (result !== null && typeof result === 'object' && result.ok === true && Array.isArray(result.value) ? result.value : []))
              for (var i = 0; i < rows.length; i++) {
                var row = rows[i]
                if (row === null || typeof row !== 'object') continue
                var active = row.activeRun
                if (active === null || typeof active !== 'object' || typeof active.packageId !== 'string') continue
                var packages = Array.isArray(row.packages) ? row.packages : []
                var pkg = undefined
                for (var j = 0; j < packages.length; j++) {
                  if (packages[j] !== null && typeof packages[j] === 'object' && packages[j].packageId === active.packageId) { pkg = packages[j]; break }
                }
                if (pkg === undefined || pkg.hasClientHalf !== true) continue
                try {
                  if (localStorage.getItem('dsh.purity.ui') === 'pure') {
                    var pid = String(row.pluginId || '')
                    var forgeDyn = pid.indexOf('forge') === 0 || pid.indexOf('plsm') === 0 || pid.indexOf('capm') === 0 || pid.indexOf('sesmgr') === 0 || pid.indexOf('fshell') === 0 || pid.indexOf('steer') === 0 || pid.indexOf('modpk') === 0
                    if (forgeDyn) continue
                  }
                } catch (error) { /* localStorage missing */ }
                var key = row.pluginId + ':' + active.packageId
                if (restoredKeys[key] === true) continue // already re-mounted in this page session
                try {
                  await ctx.dynamicCordisRunner.startUserRun({
                    agentId: row.agentId,
                    pluginId: row.pluginId,
                    packageId: active.packageId,
                    mode: 'run',
                    hasClientHalf: true
                  })
                  restoredKeys[key] = true
                } catch (error) {
                  failing = true // one failing package must not block the rest, but keeps a follow-up round
                }
              }
              if (!failing) attempts = 0 // everything in place: no more polling rounds
            } catch (error) {
              failing = true // inventory unavailable — allow the bounded follow-up round
            }
          })
        }
        function scheduleFollowUps() {
          if (attempts >= 2) return // bounded: at most two follow-up rounds (was an unconditional 6-round burst)
          attempts += 1
          setTimeout(function () {
            restore()
            scheduleFollowUps()
          }, 2000)
        }
        ctx.on('connection/reset', function () {
          attempts = 0
          restore()
          scheduleFollowUps()
        })
        restore()
        scheduleFollowUps()
      }
    }
  }
})
