// Auto-restore dynamic client packages on page boot and reconnect.
window.__ModuleLoader__.load({
  id: '@local/dsh-dynrestore',
  factory: function () {
    return {
      inject: ['remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner'],
      apply: function (ctx) {
        var gate = Promise.resolve()
        var restoredKeys = {} // pluginId:packageId -> true; suppress repeated startUserRun noise
        function restore() {
          gate = gate.then(async function () {
            try {
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
                  /* a single failing package must not block the rest */
                }
              }
            } catch (error) {
              /* inventory unavailable — retry on next reset */
            }
          })
        }
        var retries = 0
        function scheduleRetry() {
          if (retries >= 6) return
          retries += 1
          setTimeout(function () {
            restore()
            scheduleRetry()
          }, 1500)
        }
        ctx.on('connection/reset', function () {
          retries = 0
          restore()
          scheduleRetry()
        })
        restore()
        scheduleRetry()
      }
    }
  }
})
