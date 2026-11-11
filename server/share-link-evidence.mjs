import {createHash} from 'node:crypto';
import {INVITATION_ROLES} from '../src/events.js';
import {PERSONAL_INVITE_PREFIX} from './growth-loop.mjs';
import {ServiceError} from './service-error.mjs';
export const shareLinkAgentPrefix=row=>`sj_${row.id.replaceAll('-','')}_`;
export function assertShareLinkUsage(count,maxJoins){if(count>maxJoins)throw new ServiceError(503,'link_integrity_error','Invitation link usage requires operator reconciliation');}
// Preserve the original short-circuit order: access lookup happens only after
// link/issuer/status/room checks. No new authority policy is inferred here.
export function assertShareLinkJoinEvidence(join,link,record,access){
 const growth=typeof link?.request_id==='string'&&link.request_id.startsWith(PERSONAL_INVITE_PREFIX),sponsored=growth&&record?.issuer_member_id!==link.issuer_member_id;
 const issuerMatch=sponsored||(record?.issuer_account_id===link?.issuer_account_id&&record?.issuer_member_id===link?.issuer_member_id&&record?.issuer_account_auth_epoch===link?.issuer_auth_epoch&&record?.issuer_member_revision===link?.issuer_member_revision);
 const roleMatches=()=>{const value=access(),role=['co_admin','co_owner'].includes(value)?'moderator':value==='member'?'member':'guest';return record?.intended_role===role&&record.intended_permissions_json===JSON.stringify(INVITATION_ROLES[role]);};
 if(!link||!issuerMatch||record.status!=='accepted'||record.room_id!==link.room_id||!roleMatches()||record.expires_at!==link.expires_at||record.accepted_at<link.created_at||record.accepted_at>=link.expires_at||(link.revoked_at!==null&&record.accepted_at>link.revoked_at)||join.fingerprint!==createHash('sha256').update(record.intended_display_name).digest('hex'))throw new ServiceError(503,'link_integrity_error','Invitation link history requires operator reconciliation');
}
export function assertShareLinkRedemption(linkExists,accountExists){if(!linkExists()||!accountExists())throw new ServiceError(503,'link_integrity_error','Invitation link usage requires operator reconciliation');}
