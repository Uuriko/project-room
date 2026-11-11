// Existing recovery engine checks, resumable BETWEEN tables. SQLite's work
// inside a single table PRAGMA is atomic and is not a strict CPU bound.
import { Buffer } from 'node:buffer' ;
import { inRestoreContext , restoreProgress } from './restore-admission.mjs' ;
export const initialRecoveryEngine = ( ) => ( { version : 2 , stage : 'quick_check' , tableAfter : '' , quickTables : 0 , foreignKeyTables : 0 , lastBatch : null } ) ;
const fail = message => { throw Error ( 'Recovery SQLite engine requires reconciliation: ' + message ) ; } ;
export function validateRecoveryEngine ( value ) {
 if ( ! value || Object . keys ( value ) . sort ( ) . join ( ',' ) !== 'foreignKeyTables,lastBatch,quickTables,stage,tableAfter,version' || value . version !== 2
  || ! [ 'quick_check' , 'foreign_key_check' , 'complete' ] . includes ( value . stage ) || typeof value . tableAfter !== 'string' || Buffer . byteLength ( value . tableAfter ) > 512
  || ! [ 'quickTables' , 'foreignKeyTables' ] . every ( key => Number . isSafeInteger ( value [ key ] ) && value [ key ] >= 0 )
  || value . stage === 'quick_check' && value . foreignKeyTables !== 0 || value . stage === 'complete' && value . tableAfter !== '' ) fail ( 'invalid cursor' ) ;
 const b = value . lastBatch ; if ( b !== null && ( ! b || Object . keys ( b ) . sort ( ) . join ( ',' ) !== 'atoms,fromStage,fromTable,largeTable' || ! [ 'quick_check' , 'foreign_key_check' ] . includes ( b . fromStage ) || typeof b . fromTable !== 'string' || Buffer . byteLength ( b . fromTable ) > 512 || ! Number . isSafeInteger ( b . atoms ) || b . atoms < 0 || b . atoms > 16 || b . largeTable !== null && ( typeof b . largeTable !== 'string' || Buffer . byteLength ( b . largeTable ) > 512 ) ) ) fail ( 'invalid batch span' ) ;
}
export function advanceRecoveryEngine ( store , restoreId , previous , { maxTables = 16 } = { } ) {
 validateRecoveryEngine ( previous ) ; if ( ! [ 1 , 16 ] . includes ( maxTables ) ) fail ( 'invalid batch limit' ) ; const db = store . db ;
 if ( ! db . isTransaction || ! inRestoreContext ( db ) ) fail ( 'requires privileged synchronous restore transaction' ) ;
 const admission = restoreProgress ( db ) ;
 if ( admission . state !== 'pending' || admission . restore_id !== restoreId || admission . phase !== 'audit_pending' ) fail ( 'restore authority differs' ) ;
 const p = { ... previous } ; if ( p . stage === 'complete' ) return p ;
 p . lastBatch = { fromStage : p . stage , fromTable : p . tableAfter , atoms : 0 , largeTable : null } ;
 const sealed = new Map ( ( admission . seal ?. tables ?? [ ] ) . map ( entry => [ entry . name , entry ] ) ) ;
 while ( p . lastBatch . atoms < maxTables ) {
 // quick_check uses the precise legacy filter. Per-table foreign_key_check
 // visits ALL tables, preserving the former unscoped foreign_key_check.
 const filter = p . stage === 'quick_check' ? " AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'" : '' ;
 const scalar = db . prepare ( "SELECT rowid,length(CAST(name AS BLOB)) bytes FROM sqlite_master WHERE type='table'" + filter + ' AND name>? ORDER BY name LIMIT 1' ) . get ( p . tableAfter ) ;
 if ( ! scalar ) { p . stage = p . stage === 'quick_check' ? 'foreign_key_check' : 'complete' ; p . tableAfter = '' ; if ( p . stage === 'complete' ) return p ; continue ; }
 if ( ! Number . isSafeInteger ( scalar . bytes ) || scalar . bytes < 1 || scalar . bytes > 512 ) fail ( 'invalid table name' ) ;
 const row = db . prepare ( "SELECT name FROM sqlite_master WHERE rowid=? AND type='table'" ) . get ( scalar . rowid ) ;
 if ( typeof row ?. name !== 'string' || Buffer . byteLength ( row . name ) !== scalar . bytes ) fail ( 'table identity differs' ) ;
 const entry = sealed . get ( row . name ) , known = Number . isSafeInteger ( entry ?. expected ?. rows ) && entry . expected . rows >= 0 && Number . isSafeInteger ( entry . maxRowBytes ) && entry . maxRowBytes >= 0 ;
 const large = ! known || entry . expected . rows > 128 || entry . maxRowBytes > 131072 ;
 if ( large && p . lastBatch . atoms > 0 ) return p ;
 const quoted = '"' + row . name . replaceAll ( '"' , '""' ) + '"' ;
 if ( p . stage === 'quick_check' ) {
  // Match the existing oracle's exact success condition. On corruption fail
  // at the first result; do not allocate an unbounded array of diagnostics.
  if ( db . prepare ( 'PRAGMA quick_check(' + quoted + ')' ) . get ( ) ?. quick_check !== 'ok' ) fail ( 'quick_check failed for ' + row . name ) ;
  p . quickTables ++ ;
 } else {
  if ( db . prepare ( 'PRAGMA foreign_key_check(' + quoted + ')' ) . get ( ) !== undefined ) fail ( 'foreign key check failed for ' + row . name ) ;
  p . foreignKeyTables ++ ;
 }
 p . tableAfter = row . name ; p . lastBatch . atoms ++ ; if ( large ) { p . lastBatch . largeTable = row . name ; return p ; }
 } return p ;
}
