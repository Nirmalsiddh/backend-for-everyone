import { operations } from '../../../../shared/public-contracts.js';
export { operations };
export type Operation = (typeof operations)[number];
export type OperationPolicy =
  | { mode: 'key_only' | 'authenticated' }
  | { mode: 'owner'; ownerFieldId: string; allowAdmin: boolean };
export interface Endpoint {
  id: string;
  projectId: string;
  tableId: string;
  resourceName: string;
  policies?: Partial<Record<Operation, OperationPolicy>>;
  enabledOperations: Operation[];
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface EndpointInput {
  policies?: Partial<Record<Operation, OperationPolicy>>;
  enabledOperations: Operation[];
  expectedAppliedRevision: number;
  expectedConfigRevision: number;
}
export interface EndpointRepository {
  list(projectId: string, ownerId: string): Promise<Endpoint[]>;
  get(projectId: string, ownerId: string, tableId: string): Promise<Endpoint>;
  save(
    projectId: string,
    ownerId: string,
    tableId: string,
    input: EndpointInput,
  ): Promise<Endpoint>;
}
