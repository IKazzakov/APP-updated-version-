// TEST ONLY. Production uses the platform's D1 binding and Sites identity.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
export function createTestDatabase(path=':memory:',{initialOnly=false}={}) {
  const sqlite=new DatabaseSync(path); sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_squat_mvp.sql',import.meta.url),'utf8'));
  if(!initialOnly)for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')&&!f.startsWith('0000_')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
  class Statement {
    constructor(sql,args=[]) {this.sql=sql;this.args=args;}
    bind(...args) {return new Statement(this.sql,args);}
    async first(column) {const value=sqlite.prepare(this.sql).get(...this.args) ?? null;return column ? value?.[column] ?? null : value;}
    async all() {return {success:true,results:sqlite.prepare(this.sql).all(...this.args)};}
    async run() {const result=sqlite.prepare(this.sql).run(...this.args);return {success:true,results:[],meta:{changes:Number(result.changes)}};}
  }
  return {
    sqlite,prepare:sql=>new Statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results=statements.map(statement=>({success:true,results:sqlite.prepare(statement.sql).all(...statement.args)}));
        sqlite.exec('COMMIT');return results;
      } catch(error) {sqlite.exec('ROLLBACK');throw error;}
    },
    close:()=>sqlite.close(),
  };
}
