import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { T } from '../../common/db-types';

/** Rules Engine definition (SDD Section 19.2): condition -> actions, stored as data. */
@Entity({ name: 'rule_definitions' })
@Index('uq_rule_definitions', ['ownerScope', 'ruleKey'], { unique: true })
export class RuleDefinition {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'owner_scope' }) ownerScope: string;
  @Column({ ...T.str(120), name: 'rule_key' }) ruleKey: string;
  @Column({ ...T.str(250), name: 'rule_name' }) name: string;
  @Column({ ...T.str(60), name: 'entity_type' }) entityType: string;
  @Column({ ...T.str(30), name: 'trigger_on' }) triggerOn: 'on_save' | 'on_submit';
  @Column({ ...T.text(), name: 'condition_json' }) conditionJson: string;
  @Column({ ...T.text(), name: 'actions_json' }) actionsJson: string;
  @Column({ ...T.bool(), name: 'is_active' }) isActive: boolean;
  @Column({ ...T.int(), name: 'row_version' }) rowVersion: number;
  @Column({ ...T.id(), name: 'updated_by' }) updatedBy: string;
  @Column({ ...T.ts(), name: 'updated_at' }) updatedAt: Date;
}
