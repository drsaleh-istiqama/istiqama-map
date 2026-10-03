const ARABIC_MARKS=/[\u064B-\u065F\u0670\u06D6-\u06ED]/g;

export function normalizePersonName(name='') {
  return String(name).normalize('NFKC').replace(ARABIC_MARKS,'').replace(/ـ/g,'').replace(/[أإآ]/g,'ا').replace(/\s+/g,' ').trim().toLowerCase();
}

function clone(value){return JSON.parse(JSON.stringify(value))}

export class PersonDirectory {
  constructor(storage=globalThis.localStorage,key='istiqama-people-v1'){this.storage=storage;this.key=key}
  list(){try{const value=JSON.parse(this.storage.getItem(this.key)||'[]');return Array.isArray(value)?clone(value):[]}catch{return []}}
  persist(people){this.storage.setItem(this.key,JSON.stringify(people));return clone(people)}
  find(name){const normalizedName=normalizePersonName(name);return this.list().find(person=>person.normalizedName===normalizedName)||null}
  upsert(input={}){
    const name=String(input.name||'').replace(/\s+/g,' ').trim();if(!name)return null;
    const normalizedName=normalizePersonName(name),people=this.list(),index=people.findIndex(person=>person.normalizedName===normalizedName),existing=index>=0?people[index]:{id:globalThis.crypto?.randomUUID?.()||`person-${Date.now()}-${Math.random()}`,roles:[]};
    const roles=new Set(existing.roles||[]);if(input.role)roles.add(input.role);for(const role of input.roles||[])if(role)roles.add(role);
    const merged={...existing,name,normalizedName,roles:[...roles]};
    for(const key of ['birthDate','region','education','graduationInstitution','salary','phone'])if(input[key]!==undefined&&input[key]!==null&&input[key]!=='')merged[key]=input[key];
    if(index>=0)people[index]=merged;else people.push(merged);this.persist(people);return clone(merged)
  }
  seedFromProjects(projects=[]){for(const project of projects){if(project.manager)this.upsert({name:project.manager,role:'manager',phone:project.phone});for(const person of project.staff||[])this.upsert(person)}return this.list()}
}
