import { registerWorkflowCommands, type PluginBackendApi, type WorkflowCommandBinding, type WorkflowContributionContract } from '@valley/plugin-sdk'
import config from '../../config.json'

export const bindings: WorkflowCommandBinding[] = [
  {
    "nodeId": "workspace.save",
    "command": "workspace:save",
    "schemaFingerprint": "7dce6894def8976fe582d11e6e848c2115cb2ecf506790e4d4e550c8a4e59e93",
    "effect": "write"
  },
  {
    "nodeId": "workspace.load",
    "command": "workspace:load",
    "schemaFingerprint": "7a730d9646d36364b930702a9f5b31d3e8bedbb361c942bc416bc589017ed8cf",
    "effect": "write"
  },
  {
    "nodeId": "workspace.delete",
    "command": "workspace:delete",
    "schemaFingerprint": "7a730d9646d36364b930702a9f5b31d3e8bedbb361c942bc416bc589017ed8cf",
    "effect": "write"
  },
  {
    "nodeId": "workspace.rename",
    "command": "workspace:rename",
    "schemaFingerprint": "dcfd19958bd424c99c4ad58ce1a22048aad002b2abd7faf89a5886acd625a8af",
    "effect": "write"
  },
  {
    "nodeId": "workspace.list",
    "command": "workspace:list",
    "schemaFingerprint": "9864334491f500de7a98dc8ab6beb4a7321d383cd0d8c10850e13a6b23280f7b",
    "effect": "read"
  },
  {
    "nodeId": "workspace.group-create",
    "command": "workspace:group-create",
    "schemaFingerprint": "7a730d9646d36364b930702a9f5b31d3e8bedbb361c942bc416bc589017ed8cf",
    "effect": "write"
  },
  {
    "nodeId": "workspace.group-rename",
    "command": "workspace:group-rename",
    "schemaFingerprint": "dcfd19958bd424c99c4ad58ce1a22048aad002b2abd7faf89a5886acd625a8af",
    "effect": "write"
  },
  {
    "nodeId": "workspace.group-delete",
    "command": "workspace:group-delete",
    "schemaFingerprint": "7a730d9646d36364b930702a9f5b31d3e8bedbb361c942bc416bc589017ed8cf",
    "effect": "write"
  },
  {
    "nodeId": "workspace.groups",
    "command": "workspace:groups",
    "schemaFingerprint": "9864334491f500de7a98dc8ab6beb4a7321d383cd0d8c10850e13a6b23280f7b",
    "effect": "read"
  }
]

export function register(api: PluginBackendApi): () => void {
  const contribution = config.runtime.services.find(service => service.id === 'workflow.provider')!
  const registration = registerWorkflowCommands(api, contribution.metadata!.workflow as unknown as WorkflowContributionContract, bindings)
  return () => registration.dispose()
}
