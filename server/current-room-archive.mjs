// Archive is a retained reducer-context boundary, not a conversation visibility
// boundary. Canonical rows remain addressable under the ordinary room gates.
export function validateCurrentArchive(marker) {
 if(marker===null||marker===undefined)return null;
 if(marker.version!==1||Object.keys(marker).some(k=>!['version','throughSeq','count','retainedCount'].includes(k))
   ||!Number.isSafeInteger(marker.throughSeq)||marker.throughSeq<0
   ||!Number.isSafeInteger(marker.count)||marker.count<0
   ||!Number.isSafeInteger(marker.retainedCount)||marker.retainedCount<0)throw Error('projection_corrupt: normalized archive marker changed');
 return marker;
}
export function archiveRetains(marker,sequence,retainedIndex){
 const archive=validateCurrentArchive(marker);
 return !archive||sequence>archive.throughSeq||retainedIndex!==undefined;
}
export function validateArchiveRetainedSlot(index,count,occupied){
 if(!Number.isSafeInteger(index)||index<0||index>=count||occupied)throw Error('projection_corrupt: archive retained order differs');
}
export function recoverArchiveMarker(marker,entries){
 const archive=validateCurrentArchive(marker);if(!archive){if(entries.size)throw Error('projection_corrupt: orphan archive retained membership');return marker;}
 if(entries.size!==archive.retainedCount)throw Error('projection_corrupt: archive retained count differs');
 const ids=new Array(entries.size);
 for(const[id,index]of entries){validateArchiveRetainedSlot(index,ids.length,ids[index]!==undefined);ids[index]=id;}
 if(ids.some(id=>typeof id!=='string'))throw Error('projection_corrupt: archive retained membership gap');
 return {throughSeq:archive.throughSeq,count:archive.count,retainedIds:ids};
}
